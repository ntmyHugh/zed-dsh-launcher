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

const options = process.argv.slice(2);
const portOption = Number((options.find((_, i) => options[i - 1] === '--port') || '') || 0);
const noOpen = options.includes('--no-open');

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
    console.log(`DSH-Z UI: ${url}`);
    if (!noOpen) {
        spawn('powershell', ['-NoProfile', '-Command', `Start-Process msedge --app=${url}`], { stdio: 'ignore', detached: true }).unref();
    }
});

process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});
