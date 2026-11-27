#!/usr/bin/env node
/**
 * 把 Zed 里没有 ACP 会话 id 的 DeepSeek Harness 线程，匹配回 DSH 里对应的持久会话，
 * 写回 sidebar_threads.session_id，这样 Zed 下次打开线程就会走 session/load 回放历史。
 *
 * 用法（实际写入前请完全退出 Zed）：
 *   node link-zed-threads.js            # 实际写入
 *   node link-zed-threads.js --dry-run  # 只看会怎么匹配
 *
 * 匹配顺序：
 *   1) 标题完全相等（projcache title ↔ Zed thread title）；
 *   2) cwd 位于线程某个 root 之下（或相等），且 createdAt 相差 ≤ 2 分钟。
 *
 * 兼容 DSH projcache 的两种字段位置：
 *   record.identity.cwd            （rc.1 / rc.3）
 *   record.rows.workingDirectory   （旧版/变体）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DRY = process.argv.includes('--dry-run');
const TOLERANCE_MS = 120000; // 2 分钟

const ZED_DB = path.join(os.homedir(), 'AppData', 'Local', 'Zed', 'db', '0-stable', 'db.sqlite');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const LOCAL_CACHE = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

function zedRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Zed.exe', '/NH'], { encoding: 'utf8' });
    return /Zed\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** Windows / POSIX 通用规范化：统一斜杠、去掉末尾斜杠、小写比较。 */
function normPath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let p = value.replace(/\\/g, '/');
  p = p.replace(/\/+$/, '');
  // D:/code/x 与 d:/code/x 视为同一路径（Windows 不区分大小写）；
  // POSIX 路径也按小写比较，避免大小写差异造成漏匹配。
  return p.toLowerCase();
}

function within(cwd, roots) {
  const c = normPath(cwd);
  if (!c) return false;
  return roots.some((root) => {
    const r = normPath(root);
    if (!r) return false;
    return c === r || c.startsWith(r + '/');
  });
}

/** 列本机会话：{ id, cwd, title, createdAt(ms) } */
function localSessions() {
  const out = [];
  if (!fs.existsSync(LOCAL_CACHE)) return out;
  for (const file of fs.readdirSync(LOCAL_CACHE)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LOCAL_CACHE, file), 'utf8'));
      const record = data.record || {};
      const ident = record.identity || {};
      const rows = record.rows || {};
      const cwd = ident.cwd || (rows.workingDirectory && rows.workingDirectory.val);
      const title = rows.title && rows.title.val;
      if (!cwd && !title) continue;
      out.push({
        id: path.basename(file, '.json'),
        cwd,
        title: typeof title === 'string' ? title.trim() : undefined,
        createdAt: typeof ident.createdAt === 'number' ? ident.createdAt : undefined,
      });
    } catch {
      /* skip malformed cache */
    }
  }
  return out;
}

/** 列远端 DSH 会话（通过 ssh + python 读 projcache），按 host 缓存 */
const remoteCache = new Map();
function remoteSessions(host) {
  if (remoteCache.has(host)) return remoteCache.get(host);
  const py = [
    'import json,glob,os',
    'out=[]',
    'for f in glob.glob(os.path.expanduser("~/.dsh/storages/session_projcache/sessions/*.json")):',
    '    try:',
    '        d=json.load(open(f)); rec=d.get("record") or {}; i=rec.get("identity") or {}; rows=rec.get("rows") or {}',
    '        wd=(rows.get("workingDirectory") or {}).get("val")',
    '        title=(rows.get("title") or {}).get("val")',
    '        out.append({"id":os.path.basename(f)[:-5],"cwd":i.get("cwd") or wd,"createdAt":i.get("createdAt"),"title":title})',
    '    except Exception: pass',
    'print(json.dumps(out))',
  ].join('\n');
  let list = [];
  try {
    const raw = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'python3', '-'], {
      input: py,
      encoding: 'utf8',
      timeout: 30000,
    });
    list = JSON.parse(raw.trim() || '[]');
  } catch (error) {
    console.error(`! 读取远端会话失败 (${host}): ${error.message}`);
  }
  remoteCache.set(host, list);
  return list;
}

function sshHost(remoteConnectionJson) {
  try {
    const parsed = JSON.parse(remoteConnectionJson || '{}');
    const host = parsed.Ssh && parsed.Ssh.host && parsed.Ssh.host.Hostname;
    return typeof host === 'string' ? host : null;
  } catch {
    return null;
  }
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function main() {
  if (!fs.existsSync(ZED_DB)) {
    console.error('找不到 Zed 数据库: ' + ZED_DB);
    process.exit(2);
  }
  if (zedRunning() && !DRY) {
    console.error('Zed 正在运行，请先完全退出再执行（避免 WAL 冲突/被覆盖）。');
    process.exit(3);
  }

  const db = new DatabaseSync(ZED_DB, { readOnly: DRY });
  const rows = db
    .prepare(
      "SELECT thread_id, title, title_override, folder_paths, created_at, remote_connection, session_id FROM sidebar_threads WHERE agent_id='DeepSeek Harness' AND (session_id IS NULL OR session_id='')",
    )
    .all();
  if (!rows.length) {
    console.log('没有需要修复的线程。');
    return;
  }

  const local = localSessions();
  const assigned = new Set();
  let fixed = 0;
  for (const row of rows) {
    const roots = String(row.folder_paths || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    const host = sshHost(row.remote_connection);
    const sessions = host ? remoteSessions(host) : local;
    const threadTitle = normalizeTitle(row.title_override || row.title);
    if (threadTitle.length === 0) {
      console.log('- 跳过 (无标题空线程)');
      continue;
    }
    const created = Date.parse(row.created_at);

    const enriched = sessions
      .map((session) => ({
        ...session,
        delta: typeof session.createdAt === 'number' && Number.isFinite(created) ? Math.abs(session.createdAt - created) : undefined,
      }));

    // 1) 标题完全一致优先（不依赖时间与路径）。
    const byTitle = enriched.filter(
      (session) => threadTitle.length > 0 && normalizeTitle(session.title) === threadTitle,
    );

    // 2) 退回 cwd + 2 分钟时间窗（标题可能被用户改过或为空）。
    const byPath = enriched
      .filter((session) => session.delta !== undefined && session.delta <= TOLERANCE_MS && within(session.cwd, roots))
      .sort((a, b) => a.delta - b.delta);

    const best = byTitle.sort((a, b) => (a.delta ?? Infinity) - (b.delta ?? Infinity))[0] || byPath[0];
    if (best && assigned.has(best.id)) {
      console.log('- 跳过 ' + threadTitle.slice(0, 34) + ': 会话 ' + best.id + ' 已绑定到其他线程');
      continue;
    }
    const label = threadTitle.slice(0, 34) || '(无标题)';

    if (!best) {
      const detail = enriched.length === 0 ? '没有可用会话' : '标题/时间/路径均未匹配';
      console.log(`- 跳过 ${label}: ${detail}（roots=${roots.join(', ').slice(0, 50)}）`);
      continue;
    }

    const how = byTitle.length > 0 ? 'title' : 'cwd+time';
    const delta = best.delta === undefined ? '?' : `${best.delta}ms`;
    console.log(`- ${DRY ? '会绑定' : '绑定'} ${label}: ${best.id} (${how}, Δ=${delta}, cwd=${best.cwd})`);
    if (!DRY) {
      db.prepare('UPDATE sidebar_threads SET session_id = ? WHERE thread_id = ?').run(best.id, row.thread_id);
    }
    assigned.add(best.id);
    fixed++;
  }

  if (!DRY && fixed) db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  console.log(`\n完成：${DRY ? '可绑定' : '已绑定'} ${fixed} 条。`);
}

main();
