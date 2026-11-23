#!/usr/bin/env node
/**
 * dsh-zed —— DSH + Zed 运维小工具（核心 CLI）
 *
 * 命令：
 *   dsh-zed status                 查看本地 Zed、远端 server、acp 进程、会话锁（标出重复持有）
 *   dsh-zed start [--yes]          安全启动：检查 → 清理 → 链接线程 → 启动 Zed
 *   dsh-zed release <session|--duplicates> [--yes]
 *                               释放指定会话（或所有重复持有）的锁
 *   dsh-zed clean [--servers stale|all] [--acp-orphans] [--state] [--yes]
 *                               清理旧 server / 无锁 acp / server_state 残留
 *   dsh-zed link [--dry-run] [其它参数…]
 *                               调用 link-zed-threads.js 绑定线程
 *   dsh-zed windows [--prune <id,id>] [--yes]
 *                               列出/清理 Zed 会恢复的工作区窗口
 *   dsh-zed tui                    菜单界面（无参数时默认进入）
 *   dsh-zed ui                     本地 Web UI（浏览器打开）
 *
 * 所有破坏性操作都先预览，`--yes` 才执行。
 */
'use strict';

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const HOST = 'linuxServer';
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const ZED = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Zed', 'Zed.exe');
const DSH_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const LINK_SCRIPT = path.join(HOME, '.dsh', 'bin', 'link-zed-threads.js');
const REMOTE_STATUS = (() => {
    const local = path.join(__dirname, 'zed-status.sh');
    if (existsSync(local)) return local;
    const repo = path.join(__dirname, '..', 'remote', 'zed-status.sh');
    if (existsSync(repo)) return repo;
    return path.join(HOME, '.dsh', 'bin', 'zed-status.sh');
})();
const DB = path.join(process.env.LOCALAPPDATA || '', 'Zed', 'db', '0-stable', 'db.sqlite');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const yes = args.includes('--yes') || args.includes('-y');
let assumeYes = false;

function out(text = '') {
    process.stdout.write(text + '\n');
}

function execOrNull(cmd, cmdArgs, options = {}) {
    try {
        return execFileSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 60000, ...options }).trim();
    } catch (error) {
        return null;
    }
}

function ssh(command, timeout = 30000) {
    const result = spawnSync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, command],
        { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.error) throw new Error(`ssh 失败: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`ssh 命令失败 (exit ${result.status}): ${(result.stderr || '').trim().slice(0, 300)}`);
    }
    return (result.stdout || '').trim();
}

function localZedRunning() {
    const text = execOrNull('tasklist', ['/FI', 'IMAGENAME eq Zed.exe', '/NH']) || '';
    return /Zed\.exe/i.test(text);
}

function remoteStatus(deploy = true) {
    if (deploy) {
        const exists = execOrNull('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, 'test -f "$HOME/.dsh/bin/zed-status.sh" && echo yes || echo no']);
        if (!exists || !exists.includes('yes')) deployStatusScript();
    }
    const raw = ssh('bash "$HOME/.dsh/bin/zed-status.sh"');
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`无法解析远端状态输出: ${raw.slice(0, 300)}`);
    }
}

function deployStatusScript() {
    if (!existsSync(REMOTE_STATUS)) throw new Error(`本地缺少 ${REMOTE_STATUS}`);
    const content = require('node:fs').readFileSync(REMOTE_STATUS, 'utf8').replace(/\r\n/g, '\n');
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    ssh(`mkdir -p "$HOME/.dsh/bin" && printf %s ${b64} | tr -d "\\r\\n" | base64 -d > "$HOME/.dsh/bin/zed-status.sh" && chmod +x "$HOME/.dsh/bin/zed-status.sh"`);
    out('已部署 zed-status.sh 到远端');
}

function openDb() {
    let DatabaseSync;
    try {
        ({ DatabaseSync } = require('node:sqlite'));
    } catch (error) {
        throw new Error(`当前 Node 缺少 node:sqlite（${error.message}）`);
    }
    return new DatabaseSync(DB, { readOnly: true });
}

function dbWorkspaces() {
    const db = openDb();
    try {
        return db.prepare('SELECT workspace_id, paths, remote_connection_id, timestamp, window_state FROM workspaces ORDER BY timestamp DESC').all();
    } finally {
        db.close();
    }
}

function dbThreadsFor(sessionIds) {
    if (sessionIds.length === 0) return new Map();
    const db = openDb();
    try {
        const marks = sessionIds.map(() => '?').join(',');
        const rows = db.prepare(`SELECT session_id, title FROM sidebar_threads WHERE session_id IN (${marks})`).all(...sessionIds);
        return new Map(rows.map((row) => [row.session_id, row.title]));
    } finally {
        db.close();
    }
}

function short(text, width) {
    const value = String(text ?? '');
    const chars = Array.from(value);
    return chars.length > width ? chars.slice(0, width - 1).join('') + '…' : value.padEnd(width);
}

function table(headers, rows) {
    const widths = headers.map((header, index) => Math.max(Array.from(header).length, ...rows.map((row) => Array.from(String(row[index] ?? '')).length)));
    const line = (cells) => cells.map((cell, index) => short(cell, widths[index])).join('  ');
    out(line(headers));
    out(widths.map((width) => '─'.repeat(width)).join('  '));
    for (const row of rows) out(line(row));
}

function cmdStatus() {
    const remote = remoteStatus();
    const zed = localZedRunning();
    const sessionIds = remote.locks.map((entry) => entry.session);
    let titles = new Map();
    try {
        titles = dbThreadsFor(sessionIds);
    } catch {
        titles = new Map();
    }

    if (jsonOut) {
        out(JSON.stringify({ localZed: zed, ...remote }, null, 2));
        return;
    }

    out(`本地 Zed: ${zed ? '运行中（建议先退出再操作）' : '未运行'}`);
    out('');
    out(`=== 远端 zed remote server（${remote.servers.length}）===`);
    if (remote.servers.length === 0) out('  （无）');
    else table(['identifier', 'pid', '运行时长'], remote.servers.map((s) => [s.identifier + (/^setup-/.test(s.identifier) ? '（连接池，Zed 运行时会自动重连）' : ''), s.pid, s.etime]));

    out('');
    out(`=== 远端 dsh acp 进程（${remote.acp.length}）===`);
    if (remote.acp.length === 0) out('  （无）');
    else table(['pid', 'ppid', '运行时长', 'cwd'], remote.acp.map((a) => [a.pid, a.ppid, a.etime, a.cwd]));

    out('');
    out(`=== 会话锁（${remote.locks.length}）===`);
    if (remote.locks.length === 0) out('  （无）');
    else {
        const rows = remote.locks
            .slice()
            .sort((a, b) => b.holders.length - a.holders.length)
            .map((entry) => {
                const duplicate = entry.holders.length > 1 ? '⚠ 重复' : '';
                const title = entry.title || titles.get(entry.session) || '';
                return [entry.session.slice(0, 8), title.slice(0, 30), entry.holders.join(','), duplicate];
            });
        table(['session', '标题', '持有者 pid', '状态'], rows);
        if (remote.locks.some((entry) => entry.holders.length > 1)) {
            out('');
            out('提示：出现 ⚠ 重复时，用 `dsh-zed release --duplicates` 释放多出来的持有者。');
        }
    }
}

function killRemotePids(pids, reason) {
    const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
    if (unique.length === 0) return;
    ssh(`for p in ${unique.join(' ')}; do kill "$p" 2>/dev/null || true; done; sleep 1; for p in ${unique.join(' ')}; do kill -9 "$p" 2>/dev/null || true; done`);
    out(`已结束 ${unique.length} 个进程（${reason}）: ${unique.join(', ')}`);
}

function cmdRelease(target) {
    if (!target) throw new Error('用法: dsh-zed release <session-id>|--duplicates [--yes]');
    const remote = remoteStatus();
    let pids = [];
    if (target === '--duplicates') {
        for (const entry of remote.locks) {
            if (entry.holders.length > 1) {
                out(`重复持有 ${entry.session.slice(0, 8)} (${entry.title || '无标题'}): ${entry.holders.join(',')}`);
                // 保留最早启动（etime 最大）的持有者，杀掉其余
                const ordered = entry.holders
                    .map((pid) => ({ pid, etime: (remote.acp.find((a) => a.pid === pid) || {}).etime || '00:00' }))
                    .sort((a, b) => b.etime.localeCompare(a.etime));
                pids.push(...ordered.slice(1).map((item) => item.pid));
            }
        }
    } else {
        const entry = remote.locks.find((item) => item.session === target || item.session.startsWith(target));
        if (!entry) throw new Error(`没有找到会话 ${target} 的锁`);
        out(`会话 ${entry.session}（${entry.title || '无标题'}）持有者: ${entry.holders.join(',')}`);
        pids = entry.holders;
    }
    if (pids.length === 0) {
        out('没有需要释放的持有者。');
        return;
    }
    if (!yes && !confirm(`将结束进程 ${pids.join(', ')}，继续？`)) {
        out('已取消。');
        return;
    }
    killRemotePids(pids, '释放会话锁');
}

function confirm(question) {
    if (yes || assumeYes) return true;
    const result = spawnSync('powershell', ['-NoProfile', '-Command', `$a=Read-Host '${question} (y/N)'; if($a -eq 'y'){'y'}else{'n'}`], { encoding: 'utf8' });
    return (result.stdout || '').trim() === 'y';
}

function cmdClean(options) {
    const remote = remoteStatus();
    const zedRunning = localZedRunning();
    let staleServers = remote.servers.filter((server) => /^setup-/.test(server.identifier));
    if (zedRunning && staleServers.length > 0 && !args.includes('--force')) {
        out('本地 Zed 正在运行：setup-* 是 Zed 的连接池连接，结束会自动重连（跳过）。');
        out('如需强行结束，先退出 Zed，或加 --force。');
        staleServers = [];
    }
    const targets = options.servers === 'all' ? remote.servers : staleServers;
    const orphanAcp = remote.acp.filter((proc) => !remote.locks.some((entry) => entry.holders.includes(proc.pid)));

    if (targets.length === 0 && (!options.acpOrphans || orphanAcp.length === 0) && !options.state) {
        out('没有需要清理的项。');
        return;
    }

    if (targets.length > 0) {
        out('将结束这些 zed remote server:');
        table(['identifier', 'pid', '运行时长'], targets.map((s) => [s.identifier, s.pid, s.etime]));
    }
    if (options.acpOrphans && orphanAcp.length > 0) {
        out('将结束这些未持有任何会话锁的 acp 进程:');
        table(['pid', '运行时长', 'cwd'], orphanAcp.map((a) => [a.pid, a.etime, a.cwd]));
    }
    if (options.state) out('将清理远端未被使用的 server_state 目录（保留 workspace-* 正在用的）');

    if (!confirm('确认清理？')) {
        out('已取消。');
        return;
    }
    if (targets.length > 0) killRemotePids(targets.map((s) => s.pid), 'zed remote server');
    if (options.acpOrphans && orphanAcp.length > 0) killRemotePids(orphanAcp.map((a) => a.pid), '无锁 acp');
    if (options.state) {
        ssh('for d in "$HOME/.local/share/zed/server_state"/*; do [ -d "$d" ] || continue; n=$(basename "$d"); case "$n" in workspace-*) continue;; esac; rm -rf "$d" && echo "removed $n"; done');
    }
}

function cmdLink(extra) {
    if (!existsSync(LINK_SCRIPT)) throw new Error(`缺少 ${LINK_SCRIPT}`);
    if (!existsSync(DSH_EXE)) throw new Error(`缺少 ${DSH_EXE}`);
    const result = spawnSync(DSH_EXE, ['--expose-internals', LINK_SCRIPT, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 180000,
    });
    const text = (result.stdout || '') + (result.stderr || '');
    out(text.trim());
    if (result.status !== 0) throw new Error(`link 失败（exit ${result.status}）`);
}

function cmdStart() {
    if (localZedRunning()) {
        out('本地 Zed 正在运行。请先完全退出 Zed（任务管理器确认无 Zed.exe）再启动。');
        process.exitCode = 1;
        return;
    }
    const remote = remoteStatus();
    if (remote.servers.length > 0) {
        out(`远端还有 ${remote.servers.length} 个 zed remote server：`);
        table(['identifier', 'pid', '运行时长'], remote.servers.map((s) => [s.identifier, s.pid, s.etime]));
        if (!confirm('是否结束它们？')) {
            out('已取消启动。');
            return;
        }
        killRemotePids(remote.servers.map((s) => s.pid), 'zed remote server');
    }
    const locked = remote.locks.filter((entry) => entry.holders.length > 0);
    if (locked.length > 0) {
        out(`远端仍有 ${locked.length} 个会话被 acp 进程持有：`);
        table(['session', '标题', '持有者'], locked.map((entry) => [entry.session.slice(0, 8), (entry.title || '').slice(0, 30), entry.holders.join(',')]));
        if (confirm('是否释放这些锁（结束对应 acp 进程）？')) {
            killRemotePids(locked.flatMap((entry) => entry.holders), '释放会话锁');
        }
    }
    out('更新 Zed 线程链接…');
    cmdLink([]);
    out('启动 Zed…');
    spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${ZED}'`], { encoding: 'utf8' });
    out('完成。');
}

function cmdWindows(pruneIds) {
    const workspaces = dbWorkspaces();
    table(['id', '恢复窗口路径', '最后使用'], workspaces.map((row) => [
        row.workspace_id,
        String(row.paths || '').split('\n')[0] || '(空)',
        row.timestamp,
    ]));
    if (!pruneIds || pruneIds.length === 0) return;
    if (localZedRunning()) throw new Error('清理工作区记录需要先完全退出 Zed');
    const ids = pruneIds.map(Number).filter(Number.isInteger);
    const known = new Set(workspaces.map((row) => Number(row.workspace_id)));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`未知 workspace id: ${missing.join(',')}`);
    if (!confirm(`将从恢复列表删除 workspace ${ids.join(', ')}（会先备份数据库），继续？`)) {
        out('已取消。');
        return;
    }
    const backup = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(DB, backup);
    out(`已备份: ${backup}`);
    let DatabaseSync;
    ({ DatabaseSync } = require('node:sqlite'));
    const db = new DatabaseSync(DB);
    try {
        const marks = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM workspaces WHERE workspace_id IN (${marks})`).run(...ids);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
        db.close();
    }
    out(`已删除 workspace: ${ids.join(', ')}`);
}

function cmdTui() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (text) => new Promise((resolve) => rl.question(text, resolve));
    const pause = () => ask('\n按回车继续…');
    (async () => {
        while (true) {
            out('');
            out('════════ DSH + Zed 运维 ════════');
            out('  1) 状态总览');
            out('  2) 安全启动 Zed');
            out('  3) 释放会话锁');
            out('  4) 清理旧 server / 无锁 acp');
            out('  5) 链接线程（dry-run）');
            out('  6) 列出/清理恢复窗口');
            out('  7) 打开 Web UI');
            out('  0) 退出');
            const choice = (await ask('选择: ')).trim();
            try {
                if (choice === '1') cmdStatus();
                else if (choice === '2') cmdStart();
                else if (choice === '3') {
                    const target = (await ask('会话 id 前 8 位，或输入 --duplicates: ')).trim();
                    cmdReleaseInteractive(target);
                } else if (choice === '4') cmdClean({ servers: 'stale', acpOrphans: true, state: true });
                else if (choice === '5') cmdLink(['--dry-run']);
                else if (choice === '6') cmdWindows([]);
                else if (choice === '7') {
                    spawn(process.execPath, [path.join(__dirname, 'ui.js')], { stdio: 'ignore', detached: true }).unref();
                    out('已在浏览器中打开 Web UI（服务在后台运行）。');
                }
                else if (choice === '0') break;
                else out('无效选项');
            } catch (error) {
                out(`错误: ${error.message}`);
            }
            await pause();
        }
        rl.close();
    })();
}

function cmdReleaseInteractive(target) {
    const saved = process.argv;
    // 交互模式直接走同一逻辑，但确认提示交给 confirm()
    const releaseArgs = target === '--duplicates' ? ['--duplicates'] : [target];
    process.argv = [...saved.slice(0, 2), 'release', ...releaseArgs];
    cmdRelease(releaseArgs[0]);
    process.argv = saved;
}

function parseOption(name, fallback) {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function main() {
    const command = args[0] && !args[0].startsWith('-') ? args[0] : 'tui';
    switch (command) {
        case 'status':
            cmdStatus();
            break;
        case 'start':
            cmdStart();
            break;
        case 'release':
            cmdRelease(args[1]);
            break;
        case 'clean':
            cmdClean({
                servers: parseOption('--servers', 'stale'),
                acpOrphans: args.includes('--acp-orphans'),
                state: args.includes('--state'),
            });
            break;
        case 'link':
            cmdLink(args.slice(1).filter((arg) => arg !== 'link'));
            break;
        case 'windows': {
            const prune = parseOption('--prune', '');
            cmdWindows(prune ? prune.split(',').map((id) => id.trim()).filter(Boolean) : []);
            break;
        }
        case 'tui':
            cmdTui();
            break;
        case 'ui': {
            const result = spawnSync(process.execPath, [path.join(__dirname, 'ui.js'), ...args.slice(1)], { stdio: 'inherit' });
            process.exitCode = result.status ?? 0;
            break;
        }
        default:
            out(`未知命令: ${command}`);
            out('用法: dsh-zed status|start|release|clean|link|windows|tui|ui [选项]');
            process.exitCode = 2;
    }
}

main();
