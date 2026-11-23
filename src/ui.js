#!/usr/bin/env node
/**
 * dsh-zed Web UI —— 本地 HTTP 服务 + 静态页面
 *
 * 直接复用 dsh-zed.js 的 CLI（--json / --yes），避免逻辑分叉：
 *   GET  /api/status            本地 Zed + 远端状态
 *   POST /api/action            执行动作（release / clean / start / link）
 *   GET  /api/windows           Zed 恢复窗口列表
 *   POST /api/windows/prune     删除恢复窗口
 *   GET  /api/logs?lines=200    Zed 日志尾部
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOST = '127.0.0.1';
const DSHZ = path.join(__dirname, 'dsh-zed.js');
const WEB = path.join(__dirname, 'web');
const ZED_LOG = path.join(process.env.LOCALAPPDATA || '', 'Zed', 'logs', 'Zed.log');
const RUN_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'run');
const STATE_FILE = path.join(RUN_DIR, 'dsh-zed-ui.json');

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function openBrowser(url) {
    spawn('powershell', ['-NoProfile', '-Command', `Start-Process msedge --app=${url}`], { stdio: 'ignore', detached: true }).unref();
}

function stopServer() {
    const state = readState();
    if (!state || !pidAlive(state.pid)) {
        console.log('DSH-Z UI 没有在运行。');
        try { fs.unlinkSync(STATE_FILE); } catch {}
        return;
    }
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    try { fs.unlinkSync(STATE_FILE); } catch {}
    console.log(`已停止 DSH-Z UI（pid ${state.pid}, ${state.url}）`);
}

const options = process.argv.slice(2);
const portOption = Number((options.find((_, i) => options[i - 1] === '--port') || '') || 0);
const noOpen = options.includes('--no-open') || process.env.DSH_ZED_NO_OPEN === '1';

function runDshz(args, timeout = 180000) {
    const result = spawnSync(process.execPath, [DSHZ, ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) return { ok: false, output: result.error.message };
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return { ok: result.status === 0, output };
}

function status() {
    const result = runDshz(['status', '--json'], 60000);
    if (!result.ok) throw new Error(result.output || 'status 执行失败');
    try {
        return JSON.parse(result.output);
    } catch {
        throw new Error(`status 输出无法解析: ${result.output.slice(0, 300)}`);
    }
}

function release(session) {
    return runDshz(['release', session, '--yes']);
}

function clean(body) {
    const args = ['clean', '--yes'];
    if (body.servers === 'all') args.push('--servers', 'all');
    if (body.acpOrphans) args.push('--acp-orphans');
    if (body.state) args.push('--state');
    return runDshz(args);
}

function startZed() {
    return runDshz(['start', '--yes'], 300000);
}

function link(dryRun) {
    return runDshz(dryRun ? ['link', '--dry-run'] : ['link'], 180000);
}

function windows() {
    const result = runDshz(['windows'], 60000);
    if (!result.ok) throw new Error(result.output);
    return result.output;
}

function pruneWindows(ids) {
    return runDshz(['windows', '--prune', ids.join(','), '--yes'], 60000);
}

function tailLog(lines) {
    if (!fs.existsSync(ZED_LOG)) return `找不到日志: ${ZED_LOG}`;
    const text = fs.readFileSync(ZED_LOG, 'utf8').split('\n');
    return text.slice(-Math.max(1, Math.min(lines, 2000))).join('\n');
}

function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body);
}

function serveStatic(response, file) {
    const target = path.join(WEB, file === '/' ? 'index.html' : file.replace(/^\/+/, ''));
    if (!target.startsWith(WEB) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404);
        response.end('not found');
        return;
    }
    const ext = path.extname(target);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(target));
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let data = '';
        request.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1_000_000) reject(new Error('body too large'));
        });
        request.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

async function handleApi(request, response) {
    const url = new URL(request.url, `http://${HOST}`);
    try {
        if (request.method === 'GET' && url.pathname === '/api/status') {
            return sendJson(response, 200, { ok: true, data: status() });
        }
        if (request.method === 'GET' && url.pathname === '/api/windows') {
            return sendJson(response, 200, { ok: true, output: windows() });
        }
        if (request.method === 'GET' && url.pathname === '/api/logs') {
            return sendJson(response, 200, { ok: true, output: tailLog(Number(url.searchParams.get('lines') || 200)) });
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
            const body = await readBody(request);
            let result;
            switch (body.action) {
                case 'release':
                    result = release(String(body.session || ''));
                    break;
                case 'clean':
                    result = clean(body);
                    break;
                case 'start':
                    result = startZed();
                    break;
                case 'link':
                    result = link(body.dryRun !== false);
                    break;
                default:
                    return sendJson(response, 400, { ok: false, output: `未知 action: ${body.action}` });
            }
            return sendJson(response, 200, { ok: result.ok, output: result.output });
        }
        if (request.method === 'POST' && url.pathname === '/api/windows/prune') {
            const body = await readBody(request);
            const ids = (body.ids || []).map(Number).filter(Number.isInteger);
            if (ids.length === 0) return sendJson(response, 400, { ok: false, output: '缺少 ids' });
            const result = pruneWindows(ids);
            return sendJson(response, 200, { ok: result.ok, output: result.output });
        }
        return sendJson(response, 404, { ok: false, output: 'not found' });
    } catch (error) {
        return sendJson(response, 500, { ok: false, output: error.message });
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (options.includes('--stop')) {
    stopServer();
    process.exit(0);
}

if (options.includes('--detach') && !process.env.DSH_ZED_UI_CHILD) {
    const running = readState();
    if (running && pidAlive(running.pid)) {
        console.log(`DSH-Z UI 已在运行: ${running.url}`);
        openBrowser(running.url);
        process.exit(0);
    }
    const child = spawn(process.execPath, [__filename, '--no-open'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DSH_ZED_UI_CHILD: '1' },
    });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const current = readState();
        if (current && pidAlive(current.pid)) {
            console.log(`DSH-Z UI 已在后台启动: ${current.url}`);
            openBrowser(current.url);
            process.exit(0);
        }
        sleepSync(100);
    }
    console.error('DSH-Z UI 启动超时。');
    process.exit(1);
}

const server = http.createServer((request, response) => {
    if (request.url.startsWith('/api/')) {
        void handleApi(request, response);
        return;
    }
    serveStatic(response, request.url.split('?')[0]);
});

server.listen(portOption, HOST, () => {
    const port = server.address().port;
    const url = `http://${HOST}:${port}`;
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }), 'utf8');
    console.log(`DSH-Z UI: ${url}`);
    if (!noOpen) openBrowser(url);
});

function cleanupState() {
    const state = readState();
    if (state && state.pid === process.pid) {
        try { fs.unlinkSync(STATE_FILE); } catch {}
    }
}

process.on('SIGINT', () => {
    cleanupState();
    server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
    cleanupState();
    server.close(() => process.exit(0));
});
