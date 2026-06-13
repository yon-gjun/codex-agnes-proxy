/**
 * codex-agnes-proxy.js
 *
 * Translates Codex CLI Responses API streaming requests to Agnes chat/completions.
 * 
 * Key insight: Codex CLI always sends stream:true and expects multiple SSE events.
 * We simulate this by sending the full response as a single SSE data event
 * that looks like a completed stream.
 *
 * Usage: node codex-agnes-proxy.js
 * Listens on http://127.0.0.1:15721
 */

const http = require('http');
const https = require('https');

// AGNES_API_KEY: 通过环境变量读取，不硬编码在代码中
// 设置方式：
//   export AGNES_API_KEY="sk-your-key-here"   (macOS/Linux)
//   set AGNES_API_KEY=sk-your-key-here        (Windows CMD)
//   $env:AGNES_API_KEY="sk-your-key-here"     (Windows PowerShell)
const AGNES_API_KEY = process.env.AGNES_API_KEY;
if (!AGNES_API_KEY) {
  console.error('ERROR: AGNES_API_KEY environment variable is not set.');
  console.error('');
  console.error('Please set it and restart the proxy:');
  console.error('  Windows CMD:     set AGNES_API_KEY=sk-your-key');
  console.error('  Windows PowerShell:  $env:AGNES_API_KEY="sk-your-key"');
  console.error('  macOS / Linux:   export AGNES_API_KEY="sk-your-key"');
  console.error('');
  process.exit(1);
}
const AGNES_HOST = 'apihub.agnes-ai.com';
const LISTEN_PORT = 15721;

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

function translateResponsesToChat(reqBody) {
  const chatReq = {
    model: reqBody.model || 'agnes-2.0-flash',
    messages: [],
    max_tokens: reqBody.max_output_tokens || 4096,
    temperature: reqBody.temperature ?? 0.7,
    stream: false,
  };

  if (reqBody.instructions) chatReq.messages.push({ role: 'developer', content: reqBody.instructions });

  const input = reqBody.input;
  if (typeof input === 'string') {
    chatReq.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const entry of input) {
      if (entry.type === 'message') {
        const role = entry.role || 'user';
        const content = typeof entry.content === 'string' ? entry.content : extractText(entry.content);
        if (content.trim()) chatReq.messages.push({ role, content });
      } else if (entry.type === 'input_text' || entry.type === 'text') {
        const text = entry.text || '';
        if (text.trim()) chatReq.messages.push({ role: 'user', content: text });
      }
    }
  }

  if (reqBody.tools && reqBody.tools.length > 0) {
    const tools = [];
    for (const t of reqBody.tools) {
      if (t.type === 'function' && t.function) {
        tools.push({ type: 'function', function: { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || {} } });
      }
    }
    if (tools.length > 0) chatReq.tools = tools;
  }

  return chatReq;
}

function buildResponseJson(chatResp, origReq) {
  const choice = chatResp.choices?.[0] || {};
  const output = [];

  if (choice.message?.content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: choice.message.content }]
    });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        id: tc.id, type: 'function_call', status: 'completed',
        call_id: tc.id, name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}'
      });
    }
  }

  // Normalize usage to Responses API format (input_tokens/output_tokens)
  const raw = chatResp.usage || {};
  const usage = {
    input_tokens: raw.input_tokens || raw.prompt_tokens || 0,
    output_tokens: raw.output_tokens || raw.completion_tokens || 0,
    total_tokens: raw.total_tokens || 0,
    output_token_details: undefined,
  };

  const resp = {
    id: `resp_${Date.now()}`,
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model: chatResp.model || origReq.model,
    status: 'completed',
    output,
    usage,
  };
  if (origReq.tools && origReq.tools.length > 0) resp.tools = origReq.tools;
  return resp;
}

function proxyToAgnes(chatReq) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(chatReq);
    const req = https.request({
      hostname: AGNES_HOST, port: 443, path: '/v1/chat/completions',
      method: 'POST', rejectUnauthorized: false, family: 4, timeout: 120000,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGNES_API_KEY}`, 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- Server ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
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
        const chatReq = translateResponsesToChat(reqBody);
        console.log(`  -> ${chatReq.messages.length} msgs`);
        
        let result;
        try {
          result = await proxyToAgnes(chatReq);
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify({ error: `Agnes connection failed: ${e.code || e.message}` }));
          return;
        }

        if (result.status === 200) {
          const chatResp = JSON.parse(result.body);
          const responsesResp = buildResponseJson(chatResp, reqBody);
          console.log(`  <- OK tokens=${chatResp.usage?.total_tokens}`);

          const respJson = JSON.stringify(responsesResp);

          // SSE streaming: send a series of events modeling a streaming response
          // This is what Codex expects when stream=true
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          // 1) Create event (initial response with incomplete status)
          const createEvent = {
            type: 'response.created',
            response: {
              id: responsesResp.id,
              object: responsesResp.object,
              created: responsesResp.created,
              model: responsesResp.model,
              status: 'in_progress',
              output: [],
              usage: null,
            }
          };
          res.write(`data: ${JSON.stringify(createEvent)}\n\n`);

          // 2) A tiny delay to simulate real streaming
          await new Promise(r => setTimeout(r, 50));

          // 3) Output item added
          for (const item of responsesResp.output) {
            const outputEvent = {
              type: 'response.output_item.added',
              response_id: responsesResp.id,
              output_index: 0,
              item: item,
            };
            res.write(`data: ${JSON.stringify(outputEvent)}\n\n`);
            await new Promise(r => setTimeout(r, 30));
          }

          // 4) Content part added if text output exists
          for (let i = 0; i < responsesResp.output.length; i++) {
            const item = responsesResp.output[i];
            if (item.type === 'message' && item.content) {
              for (let j = 0; j < item.content.length; j++) {
                const contentEvent = {
                  type: 'response.content_part.added',
                  response_id: responsesResp.id,
                  item_id: item.content[j].type === 'output_text' ? `msg_${i}` : undefined,
                  output_index: i,
                  content_index: j,
                  part: item.content[j],
                };
                res.write(`data: ${JSON.stringify(contentEvent)}\n\n`);
                await new Promise(r => setTimeout(r, 20));
              }
            }
          }

          // 5) Text delta (final text content)
          for (let i = 0; i < responsesResp.output.length; i++) {
            const item = responsesResp.output[i];
            if (item.type === 'message' && item.content) {
              for (const part of item.content) {
                if (part.type === 'output_text') {
                  const deltaEvent = {
                    type: 'response.output_text.delta',
                    response_id: responsesResp.id,
                    output_index: i,
                    content_index: 0,
                    delta: part.text,
                  };
                  res.write(`data: ${JSON.stringify(deltaEvent)}\n\n`);
                  await new Promise(r => setTimeout(r, 30));
                }
              }
            }
          }

          // 6) Complete event with proper usage
          const completeEvent = {
            type: 'response.completed',
            response: responsesResp,
          };
          res.write(`data: ${JSON.stringify(completeEvent)}\n\n`);

          // 7) [DONE]
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(result.status, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(result.body);
        }

      } else if (url === '/v1/chat/completions') {
        try {
          const result = await proxyToAgnes(reqBody);
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
server.headersTimeout = 65000;
server.timeout = 120000;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`codex-agnes-proxy on http://127.0.0.1:${LISTEN_PORT}/v1/responses`);
});
