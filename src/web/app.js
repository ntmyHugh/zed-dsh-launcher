'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
let busy = false;
let autoTimer = null;

function log(text) {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent += `[${stamp}] ${text}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({ ok: false, output: '响应解析失败' }));
    return data;
}

function row(cells) {
    const tr = document.createElement('tr');
    for (const cell of cells) {
        const td = document.createElement('td');
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell ?? '';
        tr.appendChild(td);
    }
    return tr;
}

function setBusy(value) {
    busy = value;
    document.body.classList.toggle('busy', value);
}

async function refresh() {
    if (busy) return;
    try {
        const data = await api('/api/status');
        if (!data.ok) throw new Error(data.output || 'status 失败');
        render(data.data);
        $('updated').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        log(`刷新失败: ${error.message}`);
    }
}

function render(data) {
    $('zed-badge').textContent = `本地 Zed: ${data.localZed ? '运行中' : '未运行'}`;
    $('zed-badge').className = `badge ${data.localZed ? 'warn' : 'ok'}`;

    const servers = data.servers || [];
    $('server-count').textContent = `(${servers.length})`;
    const serversBody = $('servers').querySelector('tbody');
    serversBody.replaceChildren(...servers.map((s) => row([s.identifier, s.pid, s.etime])));

    const acp = data.acp || [];
    $('acp-count').textContent = `(${acp.length})`;
    const holders = new Set((data.locks || []).flatMap((l) => l.holders));
    const acpBody = $('acp').querySelector('tbody');
    acpBody.replaceChildren(...acp.map((a) => row([a.pid, a.etime, a.cwd, holders.has(a.pid) ? '是' : '否'])));

    const locks = data.locks || [];
    $('lock-count').textContent = `(${locks.length})`;
    const locksBody = $('locks').querySelector('tbody');
    locksBody.replaceChildren(...locks.map((item) => {
        const duplicate = item.holders.length > 1;
        const releaseButton = document.createElement('button');
        releaseButton.textContent = '释放';
        releaseButton.className = 'small danger';
        releaseButton.addEventListener('click', () => releaseSession(item));
        return row([
            item.session.slice(0, 8),
            item.title || '',
            item.holders.join(', '),
            duplicate ? '⚠ 重复持有' : '正常',
            releaseButton,
        ]);
    }));
}

async function action(payload, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
        const data = await api('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        log(data.output || (data.ok ? '完成' : '失败'));
        await refresh();
    } catch (error) {
        log(`操作失败: ${error.message}`);
    } finally {
        setBusy(false);
    }
}

function releaseSession(item) {
    action({ action: 'release', session: item.session }, `释放会话 ${item.session.slice(0, 8)} 的锁（结束持有进程 ${item.holders.join(', ')}）？`);
}

$('btn-refresh').addEventListener('click', refresh);
$('btn-start').addEventListener('click', () => action({ action: 'start' }, '启动 Zed？会先结束远端 server 并释放所有会话锁。'));
$('btn-release-dups').addEventListener('click', () => action({ action: 'release', session: '--duplicates' }, '释放所有重复持有的会话锁？'));
$('btn-clean-servers').addEventListener('click', () => action({ action: 'clean', servers: 'stale' }, '结束所有 setup-* 旧 server？'));
$('btn-clean').addEventListener('click', () => {
    action({
        action: 'clean',
        servers: $('opt-stale').checked ? 'stale' : 'none',
        acpOrphans: $('opt-orphan').checked,
        state: $('opt-state').checked,
    }, '执行所选清理？');
});

$('btn-logs').addEventListener('click', async () => {
    const data = await api('/api/logs?lines=200');
    log(data.output || '（空）');
});

$('btn-clear-log').addEventListener('click', () => { logEl.textContent = ''; });

$('btn-windows').addEventListener('click', async () => {
    const data = await api('/api/windows');
    log(data.output || '（空）');
    const body = $('windows').querySelector('tbody');
    body.replaceChildren();
    if (!data.ok) return;
    const lines = (data.output || '').split('\n').slice(2);
    for (const line of lines) {
        const match = line.match(/^(\d+)\s+(.+?)\s{2,}(\S+ \S+)\s*$/);
        if (!match) continue;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = match[1];
        checkbox.className = 'prune-box';
        body.appendChild(row([checkbox, match[1], match[2].trim(), match[3]]));
    }
});

$('btn-prune').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('.prune-box:checked')].map((box) => Number(box.value));
    if (ids.length === 0) return log('没有选中窗口');
    if (!window.confirm(`删除恢复项 ${ids.join(', ')}？需要先退出 Zed。`)) return;
    setBusy(true);
    try {
        const data = await api('/api/windows/prune', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        log(data.output || '完成');
    } finally {
        setBusy(false);
    }
});

refresh();
autoTimer = setInterval(refresh, 4000);
