/**
 * codex-agnes-proxy.js
 *
 * Translates Codex CLI Responses API streaming requests to Agnes chat/completions.
 *
 * v1.1 — Fixes:
 * 1. Context persistence: preserves conversation history across turns
 * 2. Real streaming: sends SSE events as Agnes outputs tokens in real time
 * 3. Keep-alive pings: sends : keepalive comments during long generations
 *
 * Usage: set AGNES_API_KEY and run:
 *   node codex-agnes-proxy.js
 * Listens on http://127.0.0.1:15721
 *
 * API Key 通过环境变量 AGNES_API_KEY 传入，不在代码中存储。
 * 申请地址：https://apihub.agnes-ai.com
 */

const http = require('http');
const https = require('https');

// AGNES_API_KEY 必须通过环境变量设置，代码中不存储任何密钥
const AGNES_API_KEY = process.env.AGNES_API_KEY;
if (!AGNES_API_KEY) {
  console.error('ERROR: AGNES_API_KEY environment variable is not set.');
  console.error('');
  console.error('Please set it and restart the proxy:');
  console.error('  Windows CMD:     set AGNES_API_KEY=***                                         ');
  console.error('  Windows PowerShell:  $env:AGNES_API_KEY="***"                                  ');
  console.error('  macOS / Linux:   export AGNES_API_KEY="***"                                    ');
  console.error('');
  process.exit(1);
}

const AGNES_HOST = process.env.AGNES_HOST || 'apihub.agnes-ai.com';
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '15721', 10);
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-2.0-flash';

// ==================== Conversation Context Cache ====================
// Codex sends only the new user input each turn. We need to maintain
// conversation history locally so Agnes has context for coherent replies.
const MAX_HISTORY_TURNS = 20;
// Map<response_id, history>
// history = { previousMessages: [...], responseIdChain: [...] }
const contextCache = new Map();

function getOrCreateContext(responseId, maxOutputTokens) {
  if (!contextCache.has(responseId)) {
    contextCache.set(responseId, {
      previousMessages: [],
      responseIdChain: [responseId],
      originalMaxTokens: maxOutputTokens,
    });
  }
  return contextCache.get(responseId);
}

function updateContext(responseId, userMessages, assistantContent, incomingResponseId) {
  const ctx = getOrCreateContext(responseId);
  // Add user message(s)
  for (const msg of userMessages) {
    ctx.previousMessages.push(msg);
  }
  // Add assistant response
  if (assistantContent) {
    ctx.previousMessages.push({ role: 'assistant', content: assistantContent });
  }
  // Trim to max turns
  if (ctx.previousMessages.length > MAX_HISTORY_TURNS * 2) {
    ctx.previousMessages = ctx.previousMessages.slice(-MAX_HISTORY_TURNS * 2);
  }
  // Track response ID chain
  if (incomingResponseId && !ctx.responseIdChain.includes(incomingResponseId)) {
    ctx.responseIdChain.push(incomingResponseId);
  }
}

// ==================== Translation Functions ====================

function extractText(input) {
  let texts = [];
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const b of input) {
      if (b.type === 'input_text' || b.type === 'text') texts.push(b.text || b.content || '');
    }
  }
  return texts.join('\n');
}

/**
 * Translate Responses API input into chat messages, maintaining conversation context.
 */
function translateResponsesToChat(reqBody, previousMessages) {
  const instructions = reqBody.instructions || '';
  const input = reqBody.input;
  const userMessages = [];

  const messages = [];

  // System / developer instructions first
  if (instructions) {
    messages.push({ role: 'developer', content: instructions });
  }

  // Append conversation history (if any)
  if (previousMessages && previousMessages.length > 0) {
    // Filter out the developer message from history to avoid duplicates
    const history = previousMessages.filter(m => m.role !== 'developer' && m.role !== 'system');
    messages.push(...history);
  }

  // Extract current user input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    userMessages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const entry of input) {
      if (entry.type === 'message') {
        const role = entry.role || 'user';
        const content = typeof entry.content === 'string' ? entry.content : extractText(entry.content);
        if (content.trim()) {
          const msg = { role, content };
          messages.push(msg);
          if (role === 'user') userMessages.push(msg);
        }
      } else if (entry.type === 'input_text' || entry.type === 'text') {
        const text = entry.text || '';
        if (text.trim()) {
          const msg = { role: 'user', content: text };
          messages.push(msg);
          userMessages.push(msg);
        }
      }
    }
  }

  const chatReq = {
    model: reqBody.model || AGNES_MODEL,
    messages,
    max_tokens: reqBody.max_output_tokens || 8192,
    temperature: reqBody.temperature ?? 0.7,
    stream: true, // <-- KEY CHANGE: use real streaming from Agnes
  };

  if (reqBody.tools && reqBody.tools.length > 0) {
    const tools = [];
    for (const t of reqBody.tools) {
      if (t.type === 'function' && t.function) {
        tools.push({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || {} } });
      }
    }
    if (tools.length > 0) chatReq.tools = tools;
  }

  return { chatReq, userMessages };
}

/**
 * Build the final Responses-API-style JSON from the full accumulated content.
 */
function buildFinalResponse(content, model, origReq, usage) {
  const output = [];
  if (content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: content }],
    });
  }

  const resp = {
    id: `resp_${Date.now()}`,
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model: model || origReq.model,
    status: 'completed',
    output,
    usage: {
      input_tokens: usage?.input_tokens || usage?.prompt_tokens || 0,
      output_tokens: usage?.output_tokens || usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
    },
  };
  if (origReq.tools && origReq.tools.length > 0) resp.tools = origReq.tools;
  return resp;
}

// ==================== Agnes API Streaming Call ====================

function streamFromAgnes(chatReq, onToken, onComplete, onError) {
  const postData = JSON.stringify(chatReq);

  const req = https.request({
    hostname: AGNES_HOST,
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    rejectUnauthorized: false,
    family: 4,
    timeout: 180000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AGNES_API_KEY}`,
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'text/event-stream',
    },
  });

  let accumulatedContent = '';
  let usage = {};
  let buffer = '';

  req.on('response', (res) => {
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', c => errBody += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(errBody);
          onError(new Error(`Agnes API error ${res.statusCode}: ${parsed.error?.message || errBody}`));
        } catch {
          onError(new Error(`Agnes API error ${res.statusCode}: ${errBody}`));
        }
      });
      return;
    }

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            if (data.choices && data.choices[0]) {
              const delta = data.choices[0].delta;
              if (delta && delta.content) {
                accumulatedContent += delta.content;
                onToken(delta.content);
              }
            }
            if (data.usage) {
              usage = data.usage;
            }
          } catch {
            // skip malformed SSE line
          }
        }
      }
    });

    res.on('end', () => {
      // Process remaining buffer
      if (buffer.trim().startsWith('data: ')) {
        try {
          const jsonStr = buffer.trim().slice(6);
          if (jsonStr !== '[DONE]') {
            const data = JSON.parse(jsonStr);
            if (data.usage) usage = data.usage;
          }
        } catch { /* skip */ }
      }
      onComplete(accumulatedContent, usage);
    });

    res.on('error', (e) => onError(e));
  });

  req.on('error', (e) => onError(e));
  req.on('timeout', () => { req.destroy(); onError(new Error('Agnes stream timeout')); });
  req.write(postData);
  req.end();

  return req; // return so we can abort if needed
}

// ==================== SSE Event Helpers ====================

function sendSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendKeepAlive(res) {
  res.write(': keepalive\n\n');
}

// ==================== HTTP Server ====================

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'codex-agnes-proxy', model: AGNES_MODEL }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(''); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const reqBody = JSON.parse(body);
      const url = (req.url || '').replace(/\/+$/, '');
      console.log(`[${new Date().toISOString()}] ${url}`);

      if (url === '/v1/responses') {
        // ==================== Step 1: Parse request ====================
        // Determine context from previous_response_id if present
        const previousResponseId = reqBody.previous_response_id;
        let history = null;

        if (previousResponseId && contextCache.has(previousResponseId)) {
          history = contextCache.get(previousResponseId).previousMessages;
          console.log(`  <- context from previous_response_id: ${previousResponseId}`);
        }

        const { chatReq, userMessages } = translateResponsesToChat(reqBody, history);
        const currentResponseId = `resp_${Date.now()}`;

        console.log(`  -> ${chatReq.messages.length} msgs (${userMessages.length} new user)`);

        // ==================== Step 2: Set up SSE response ====================
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Send response.created event immediately
        sendSSE(res, {
          type: 'response.created',
          response: {
            id: currentResponseId,
            object: 'response',
            created: Math.floor(Date.now() / 1000),
            model: chatReq.model,
            status: 'in_progress',
            output: [],
            usage: null,
          },
        });

        // ==================== Step 3: Stream from Agnes ====================
        let fullContent = '';
        let finalUsage = {};
        let streamError = null;
        let keepAliveTimer = null;

        // Keep-alive ping every 5s during streaming to prevent Codex timeout
        keepAliveTimer = setInterval(() => sendKeepAlive(res), 5000);

        const result = await new Promise((resolve, reject) => {
          streamFromAgnes(
            chatReq,
            // onToken: send output_text.delta for each token
            (tokenText) => {
              fullContent += tokenText;

              // If this is the first token, send output_item.added first
              if (fullContent.length === tokenText.length) {
                sendSSE(res, {
                  type: 'response.output_item.added',
                  response_id: currentResponseId,
                  output_index: 0,
                  item: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '' }],
                  },
                });
                sendSSE(res, {
                  type: 'response.content_part.added',
                  response_id: currentResponseId,
                  item_id: `msg_0`,
                  output_index: 0,
                  content_index: 0,
                  part: { type: 'output_text', text: '' },
                });
              }

              // Send the token as delta
              sendSSE(res, {
                type: 'response.output_text.delta',
                response_id: currentResponseId,
                output_index: 0,
                content_index: 0,
                delta: tokenText,
              });
            },
            // onComplete
            (content, usage) => {
              resolve({ content, usage });
            },
            // onError
            (err) => {
              reject(err);
            }
          );
        });

        clearInterval(keepAliveTimer);
        keepAliveTimer = null;

        fullContent = result.content;
        finalUsage = result.usage;

        // ==================== Step 4: Send completion events ====================
        // Build final response JSON
        const finalResp = buildFinalResponse(fullContent, chatReq.model, reqBody, finalUsage);

        // Update the message content with accumulated text
        if (finalResp.output[0] && finalResp.output[0].content) {
          finalResp.output[0].content[0].text = fullContent;
        }

        sendSSE(res, {
          type: 'response.completed',
          response: finalResp,
        });

        res.write('data: [DONE]\n\n');
        res.end();

        // ==================== Step 5: Save conversation context ====================
        // Link to previous context or create new chain
        if (previousResponseId && contextCache.has(previousResponseId)) {
          const prevCtx = contextCache.get(previousResponseId);
          updateContext(previousResponseId, userMessages, fullContent, currentResponseId);
          // Copy to current response ID for easy lookup next turn
          contextCache.set(currentResponseId, {
            previousMessages: [...prevCtx.previousMessages],
            responseIdChain: [...prevCtx.responseIdChain, currentResponseId],
            originalMaxTokens: prevCtx.originalMaxTokens,
          });
        } else {
          updateContext(currentResponseId, userMessages, fullContent, currentResponseId);
        }

        console.log(`  <- ${fullContent.length} chars, ${finalUsage?.total_tokens || '?'} tokens`);

      } else if (url === '/v1/chat/completions') {
        // Direct pass-through for chat/completions (non-streaming)
        try {
          const postData = JSON.stringify({ ...reqBody, stream: false });
          const result = await new Promise((resolve, reject) => {
            const req2 = https.request({
              hostname: AGNES_HOST, port: 443, path: '/v1/chat/completions',
              method: 'POST', rejectUnauthorized: false, family: 4, timeout: 120000,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AGNES_API_KEY}`,
                'Content-Length': Buffer.byteLength(postData),
              },
            }, (r) => {
              let b = '';
              r.on('data', c => b += c);
              r.on('end', () => resolve({ status: r.statusCode, body: b }));
            });
            req2.on('error', e => reject(e));
            req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
            req2.write(postData);
            req2.end();
          });
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(result.body);
        } catch (e) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
    }
  });
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 120000;
server.timeout = 300000;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`codex-agnes-proxy v1.1 on http://127.0.0.1:${LISTEN_PORT}/v1/responses`);
  console.log(`Model: ${AGNES_MODEL} | Host: ${AGNES_HOST}`);
});
