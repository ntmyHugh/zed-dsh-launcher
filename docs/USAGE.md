# dsh-zed — DSH + Zed 运维工具

位置：`~/.dsh/bin/dsh-zed.cmd`（底层 `dsh-zed.js`，使用 DSH 自带 Node 运行）
入口：桌面 `ss\DSH-Z 控制台.bat`

## 命令

| 命令 | 作用 |
|---|---|
| `dsh-zed status` | 本地 Zed 状态、远端 zed server、acp 进程、会话锁（标出重复持有） |
| `dsh-zed start` | 安全启动：本地 Zed 未运行 → 清理远端 server（确认）→ 释放锁（确认）→ 链接线程 → 启动 Zed |
| `dsh-zed release <会话id前8位>` | 结束持有该会话锁的进程 |
| `dsh-zed release --duplicates` | 只处理被多个进程持有的会话：保留运行最久的，杀掉其余 |
| `dsh-zed clean` | 清理 `setup-*` 旧 server（预览 + 确认） |
| `dsh-zed clean --acp-orphans --state` | 额外清理未持锁的 acp 进程和失效 server_state |
| `dsh-zed link [--dry-run]` | 调用 link-zed-threads.js 绑定线程 |
| `dsh-zed windows` | 列出 Zed 会恢复的工作区窗口（id / 路径 / 最后使用） |
| `dsh-zed windows --prune 50,71` | 删除指定恢复项（需先退出 Zed，自动备份 db.sqlite） |
| `dsh-zed tui` | 菜单界面（无参数时默认） |

所有破坏性操作默认预览并要求确认；加 `--yes` 跳过确认（脚本/自动化用）。

## 依赖

- 本地：DeepSeek Harness（Node 运行时）、Zed、ssh 到 `linuxServer` 免密；
- 远端：`~/.dsh/bin/zed-status.sh`（首次运行 status 时自动部署）。

## 典型流程

1. 退出 Zed；
2. 双击 `DSH-Z 控制台.bat` → `2` 安全启动；
3. 出现 `already owned` 时：`1` 看状态 → `3` 释放对应会话锁，或 `release --duplicates`。