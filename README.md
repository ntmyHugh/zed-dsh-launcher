# zed-dsh-launcher

**DSH-Z**（命令行：`dsh-zed`）—— 管理 **Zed + DeepSeek Harness (DSH)** 这套远程开发环境的运维小工具。

> 命名说明：产品名是 **DSH-Z**；命令和源码文件使用 `dsh-zed`。更早的 `dshz` 是旧名，已弃用，`install.ps1` 会自动清理旧文件。

解决长期使用中反复出现的几类问题：

- 同一个 DSH 会话被多个 Zed 窗口/进程同时加载，报
  `session "..." is already owned by an active write handle`；
- 远端残留的 `zed-remote-server` 与无主 `dsh --profile acp` 进程
  （注意：`setup-*` 是 Zed 的连接池连接，Zed 运行时会自动重连，不属于残留）；
- Zed 启动时恢复过多个工作区窗口，导致重复加载；
- 线程 `session_id` 丢失/为空，历史会话打不开。

## 功能

| 命令 | 作用 |
|---|---|
| `dsh-zed status` | 本地 Zed 状态、远端 zed server、acp 进程、会话锁（标出重复持有） |
| `dsh-zed start` | 安全启动：检查本地 Zed → 清理远端 server（确认）→ 释放锁（确认）→ 链接线程 → 启动 Zed |
| `dsh-zed release <id前8位>` | 结束持有该会话锁的进程 |
| `dsh-zed release --duplicates` | 只处理被多个进程持有的会话：保留运行最久的，结束其余 |
| `dsh-zed clean` | 清理 `setup-*` 旧 server（预览 + 确认） |
| `dsh-zed clean --acp-orphans --state` | 额外清理未持锁的 acp 进程与失效 `server_state` |
| `dsh-zed link [--dry-run]` | 调用 `link-zed-threads.js` 补线程 `session_id` |
| `dsh-zed windows` | 列出 Zed 会恢复的工作区窗口（id / 路径 / 最后使用） |
| `dsh-zed windows --prune 50,71` | 删除指定恢复项（需先退出 Zed，自动备份 `db.sqlite`） |
| `dsh-zed tui` | 菜单界面（无参数时默认） |

破坏性操作默认先预览再确认；`--yes` 跳过确认，供脚本调用。

## Web UI

`dsh-zed ui` 会启动本地服务并（默认）用 Edge 应用窗口打开：

```bat
dsh-zed ui                 :: 自动选择端口并打开
dsh-zed ui --port 18080    :: 固定端口
dsh-zed ui --no-open       :: 只起服务
```

页面功能：状态总览（server / acp / 会话锁，重复持有标 ⚠）、按会话释放锁、清理旧 server/无锁进程/残留状态、一键启动 Zed、加载并删除 Zed 恢复窗口、查看 Zed 日志尾部、操作输出面板，每 4 秒自动刷新。

前端零框架（原生 HTML/JS），后端 `src/ui.js` 通过调用 `dsh-zed` CLI（`--json` / `--yes`）复用同一套逻辑，避免业务分叉。

### 运行方式

桌面 `DSH-Z UI.bat` 使用**前台模式**：

1. 双击后启动本地服务，并自动打开浏览器页面；
2. 终端窗口保持打开，它就是服务宿主；
3. **关闭终端窗口即停止服务**（页面随之失效），符合“用完即关”的习惯。

也支持后台模式（可选）：

- `dsh-zed ui --detach`：后台启动，状态记录在 `~/.dsh/run/dsh-zed-ui.json`；
- `dsh-zed ui --stop`：停止后台服务。
## 安装

1. 依赖：
   - Windows + DeepSeek Harness（内置 Node 运行时）；
   - Zed；
   - 到远端主机的 ssh 免密（默认主机名 `linuxServer`，可在 `src/dsh-zed.js` 顶部修改）；
   - 远端已配置 `~/.dsh/bin/link-zed-threads.js`、`cleanup-acp.sh`（本工具会复用）。
2. 在 PowerShell 中执行：

```powershell
cd D:\code\tools\zed-dsh-launcher
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

- 把 `src/dsh-zed.js`、`remote/zed-status.sh` 复制到 `%USERPROFILE%\.dsh\bin\`；
- 把 `bin/dsh-zed.cmd`、`desktop/DSH-Z 控制台.bat` 转成 GBK + CRLF 后写入目标位置；
- 在桌面 `ss` 目录创建入口（如不存在则创建）。

首次运行 `dsh-zed status` 时会把 `zed-status.sh` 自动部署到远端。

## 使用

双击桌面 `ss\DSH-Z 控制台.bat`，或命令行：

```bat
dsh-zed status
dsh-zed start
dsh-zed release --duplicates
```

### 遇到 `already owned` 时

1. `dsh-zed status` 找到对应会话的持有者 pid；
2. `dsh-zed release <会话 id 前 8 位>`；
3. 在 Zed 里重新打开该线程（只打开一次，等待加载完成）。

### 减少复发

- 退出 Zed 前只保留一个窗口（多余的远程窗口会在下次启动时一起恢复）；
- 必要时 `dsh-zed windows` 查看恢复列表，用 `--prune` 删除不用的窗口记录；
- 用 `dsh-zed start` 代替手动启动。

## 目录结构

```
src/dsh-zed.js            核心逻辑（Node CLI）
src/ui.js              本地 Web UI 服务（HTTP API + 静态页）
src/web/               UI 前端（index.html / app.js / style.css）
bin/dsh-zed.cmd           Windows 入口（自动定位 DSH 自带 Node）
remote/zed-status.sh   远端状态采集脚本（JSON 输出）
desktop/DSH-Z 控制台.bat  菜单入口
docs/USAGE.md          命令速查
install.ps1            安装脚本
```

## 关于 setup-* 连接

远端标识为 `setup-N` 的进程是 Zed 的**连接池/初始化连接**（源码中的 `ConnectionIdentifier::Setup`），不是窗口对应的 `workspace-N`。Zed 运行期间杀掉它，客户端会立刻用 `--reconnect` 重连，因此：

- **Zed 运行时不要清理 setup-***（`dsh-zed clean` 已默认跳过并提示）；
- 它不持有会话锁、不跑 agent，留着无害；
- 只有在 **Zed 已退出**后仍残留的 setup-* 才是孤儿，可以清理（`dsh-zed clean --force`）。
## 已知限制

- `windows --prune` 需要先完全退出 Zed，且会修改 Zed 的 `db.sqlite`（自动备份）；
- 远端主机名、Zed/DSH 路径在 `src/dsh-zed.js` 顶部常量中配置；
- 目前是 CLI/TUI；本地 Web GUI（同一套命令的界面外壳）是后续计划。

## Roadmap

- [ ] 本地 Web GUI（状态表格 + 一键操作）
- [ ] 锁冲突后台告警/自动处理
- [ ] 集成 clangd 索引、Semble MCP、串口状态
- [ ] 会话分支：`session/fork` + 新线程绑定
