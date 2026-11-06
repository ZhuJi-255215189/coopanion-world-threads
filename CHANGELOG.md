# Changelog

## 0.1.2 — 2026-11-07

- `start()` 立即返回：读档与补保底移到微任务，避免任何同步 I/O / 建线程卡住 World 挂载。
- 初始化、读档、补保底、工具、线程完成/失败都有日志（`多线程：…`），失败不再静默。
- `envPromptVars()` 与四个工具都包了兜底：单个工具异常只回失败回执，不会把整个 World 拖下水。
- `stop()` 逐线程 try/catch，先存档再作废。
- README 增加「启用时机与排障」：运行中启用会等当前回合的批末，HTTP 可能先超时；建议配置开启后重启。

## 0.1.1 — 2026-11-07

- 安装脚本一并复制 `docs/` 与 `CHANGELOG.md`，安装后的包与仓库内容一致。

## 0.1.0 — 2026-11-07

首个版本。

- 线程池：空闲保底 `reserveIdle`（默认 1）、按需增长、`queue` / `borrow` 两种满池策略。
- 工具：`thread_ask`、`thread_tell`、`thread_list`、`thread_stop`。
- 回报事件：`threads.report` / `threads.error`，由主 session 用自己的口吻转述。
- 每条线程独立上下文、独立模型调用；用量经 `reportUsage` 记入部署账本。
- 实时线程池面板：忙/闲/排队、每条线程的状态与最近一句、端点状态、单条停止。
- 端点默认跟随激活的 provider；Responses 优先，404/405 自动退回 Chat Completions。
- 线程存档 `<deployment>/data/threads/state.json`，重启接回历史。
- 测试：17 项单元测试 + 17 项端到端（假端点）+ Cortico dry-mount 检查。
