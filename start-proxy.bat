@echo off
REM ======================
REM Codex Agnes Proxy 启动脚本
REM ======================
REM
REM 使用前请先设置 Agnes API Key：
REM   1. 前往 https://apihub.agnes-ai.com 申请 API Key
REM   2. 取消下面一行的注释，替换为你的 Key
REM      set AGNES_API_KEY=sk-你的-Key-粘贴到这里
REM
REM 或者直接将 AGNES_API_KEY 添加到系统环境变量
REM ======================

REM 如果要设置 Key，取消下面这行的注释，粘贴你的 Key
REM set AGNES_API_KEY=sk-your-key-here

REM 如果未设置环境变量，启动时代理会报错退出
start /B /MIN node "%~dp0codex-agnes-proxy.js"
echo codex-agnes-proxy started on http://127.0.0.1:15721
echo.
echo NOTE: If the proxy fails, make sure AGNES_API_KEY is set!
echo See the comments in this bat file for instructions.
