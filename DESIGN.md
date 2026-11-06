# 多线程桌宠：设计说明

> 给 Coopanion 的桌宠加一套并行线程：一条在干活时可以顺便接话；两件事同时在跑时自动开第三条；**始终有一条线程空闲**。

这份文档讲三件事：需求怎么落成规则、为什么落在一个 World 扩展上、以及哪些边界是故意留着的。

---

## 1. 需求拆成三条规则

原话拆开看：

1. **「在处理一个问题的时候能顺便接话」** —— 长任务不能占住唯一那条思路。
2. **「两个问题同时处理的时候，就可以开第三个线程」** —— 并发要能自己长出来，而不是事先定死 N 条。
3. **「始终有一个线程处于空闲状态」** —— 永远留一条接新消息，不能等池子全满了才排队。

第 3 条是关键。它把「线程数」从一个固定值变成了一个**带保底的水位**：

```
线程总数 = 在忙的 + 空闲的，且 空闲的 ≥ reserveIdle（默认 1）
```

于是：

- 空闲 1 条、池子没满 → 不把最后那条空闲派出去，而是**开一条新的**，派新的那条；原来那条继续空闲。
- 空闲 ≥ 2 条 → 复用最久没动的那条，不再长。
- 池子到上限、只剩保底那条 → 排队（或按配置临时借用保底，见 §4.4）。

「两件事在跑时开第三条」是这条规则的推论：2 忙时池子里其实有 3 条（2 忙 + 1 闲），第三件事进来会开第 4 条（3 忙 + 1 闲）；到 `maxThreads` 才停。

---

## 2. 现有系统给的位置

Coopanion 建在 Cortico 上（`src/core/`），桌宠的「思路」是 Core 的**主 session**：

- `Persona.declareSessions()` 里必须恰有一个 `receivesEvents + persistent` 的 session（Cormini 的 `main`）。
- 主循环一次处理一批事件；工具调用是串行的，长任务（写东西、整理、CUA）会把这条 session 占住。
- 桌宠的聊天、语音、电脑操作都在 `cortico-world-desktop-pet` 这个 World 里；用户消息以 `desktop-pet.message` 事件、`preempt` 方式投递。
- 扩展系统只支持三类包：`world` / `provider` / `bot`（API 6）。Coopanion 的 bot 写死为 Cormini，部署的 `deployment.json` 只认 `cormini`；所以 **bot 扩展这条路走不通**。
- World 能做的事：`pushEvent` 推事件、`tools()` 给工具、`webUi()` 给面板、`reportUsage` 记账，以及**自己调模型**（`localvision` 一类扩展就是这么做的）。

所以并行能力只能、也正好应该落在 **World** 层：

```
用户 ──► desktop-pet World ──► 主 session（唯一，常驻）
                                   │ thread_ask / thread_tell
                                   ▼
                             threads World（线程池）
                              ├ t1  空闲（保底）
                              ├ t2  忙 ──► /responses
                              └ t3  忙 ──► /responses
                                   │ threads.report 事件
                                   ▼
                             主 session ──► pet_say ──► 用户
```

主 session 仍然是**唯一的嘴**：线程不直接对用户说话，它们把结果交回来，桌宠用自己的口吻说出来。这样人格、记忆、说话风格都不分裂。

---

## 3. 为什么不让线程直接「说」

三个理由：

1. **人格一致**：桌宠的语气来自 Persona、前缀与 `pet_say`；线程直接发声会变成另一个声音。
2. **事件顺序**：多个线程同时说话，谁先谁后、要不要合并，只有主 session 知道当前对话的语境。
3. **可撤回**：主 session 可以选择不说、等对方说完再说、或把几条结果合成一句。

代价是每条线程结束后要多一次主 session 的回合。这是可接受的：那次回合很短（读一条回报、说一句），而长任务本身已经在线程里跑完了。

---

## 4. 线程池规则

实现：`src/pool.ts`（纯函数式，不碰模型与文件）。

### 4.1 状态与计数

- 一条线程只有两种状态：`idle` / `running`。
- 池子计数：`size`、`idle`、`running`、`queued`、`max`、`reserve`，以及 `reserveMet`（此刻空闲是否够保底）。

### 4.2 派活算法

```
plan():
  idle = 空闲线程（按最久没动排序）
  if idle 数量 > reserve            → reuse 最久没动的那条
  else if size < maxThreads         → spawn 一条新的
  else if onFull == 'borrow' && idle 存在 → reuse 保底那条（借用）
  else                              → queue
```

对应到实际操作：

- `reuse`：`assign(线程)` → `thread.start(任务)`（新任务会清掉旧上下文）。
- `spawn`：`threadFor('t'+seq)` → `assign` → `start`。
- `queue`：任务进 FIFO；等某条 `release` 后再走一遍 `plan()`。

每次派完活、每次线程空下来，都调用一次 `ensureReserve()`：补空闲线程直到 `idle ≥ reserve`（受 `maxThreads` 限制）。

### 4.3 场景表（`maxThreads = 4`，`reserveIdle = 1`）

| 时刻 | 忙 | 闲 | 池子 | 新任务进来 |
|---|---|---|---|---|
| 刚启动 | 0 | 1 | 1 | 开新线程（spawn），闲仍为 1 |
| 第 1 件在跑 | 1 | 1 | 2 | spawn → 3 条，忙 2 闲 1 |
| 第 2 件在跑 | 2 | 1 | 3 | spawn → 4 条，忙 3 闲 1 |
| 第 3 件在跑 | 3 | 1 | 4 | 排队（或 borrow） |
| 一条干完 | 2 | 2 | 4 | 队列里的活复用一条闲线程 → 忙 3 闲 1 |

这条「不把最后一条空闲派出去」的规则，就是「两件事在跑时开第三条」的来历。

### 4.4 满了怎么办：queue 与 borrow

- `queue`（默认）：保底不破。第四件事等，等谁空出来就先跑谁。
- `borrow`：临时借用保底那条，先干起来；等别的线程空下来，`ensureReserve()` 把保底补回去。借用期间 `reserveMet = false`，面板会标出来。

默认选 `queue`：需求里「始终有一个线程空闲」是硬话；`borrow` 是给「更跟手、能接受偶尔没有空位」的人留的开关。

### 4.5 不变量（单元测试覆盖）

- `running + idle == size`
- `reserveIdle ≤ maxThreads − 1`（`maxThreads = 1` 时为 0）
- `queue` 模式下，只要还有忙的线程，池子至少留 1 条空闲
- 复用优先最久没动的空闲线程（LRU），刚空下来的留作保底
- `deficit()` 只补到保底，不无限长

---

## 5. 一条线程的生命周期

实现：`src/thread.ts`。

```
         start(task)                 模型返回
 idle ──────────────► running ──────────────► idle
   ▲                     │  ▲
   │      tell(line)     │  │  inbox 里还有 → 接着答
   └─────────────────────┘  │
                            └── 每轮答完先 onReply，再看 inbox
```

- `start(text, title)`：清空旧历史，作为新任务开始；标题取 `title` 或任务开头。
- `tell(text)`：保留历史，把这句话排进 inbox；如果线程正忙，不打断当前模型调用，等这一轮答完再答。
- `dispose()`：中止、作废；之后的回调不再发生。
- 每条线程保留 `historyTurns × 2` 条消息；裁剪时从一条 `user` 消息开始，避免上下文从半句话开始。
- 失败不丢线程：记下 `lastError`、回调 `onError`，然后回到 idle，池子照常放行。

「顺便接话」在线程内部也成立：同一条线程忙时收到补充，不会丢，也不会打断在途请求，只是排在下一轮。

---

## 6. 三条路由

用户的话始终先到主 session。主 session 按前缀里的规则（`ENV_PROMPT.md`）决定：

| 用户说的话 | 走哪条 | 为什么 |
|---|---|---|
| 闲聊、打岔、问一句 | 主 session 自己答 | 主 session 空着，答得最快 |
| 给某条在跑的线程补条件 | `thread_tell` | 它已经带着上下文，转过去最省 |
| 新的、要花一会儿的事 | `thread_ask` | 主 session 立刻回来陪人 |
| 需要看屏幕/动电脑 | 主 session 自己的 `pet_cua_*` | 线程碰不到电脑，也不该碰 |
| 线程干完的回报 | 主 session 转述 | 人格与语气统一 |

前缀里明确写了「不要说我的线程正在……」，避免把内部机制漏给用户。

---

## 7. 模型调用与用量

实现：`src/model.ts`。

### 7.1 端点解析（留空即跟随部署）

1. 读部署 `config.json` 的 `activeProvider`。
2. 读 `<部署根>/providers/<activeProvider>/config.json`：`baseUrl`、`spec.model`、`secret`（密钥变量名）。
3. 密钥按 Cortico 的 `secretReader` 同序读：非空进程环境变量 → provider 的 `.env` → 部署的 `.env`。
4. 扩展配置的 `endpoint` / `model` / `apiKeyEnv` 可以整体覆盖；这让线程能单独接一个更便宜或更快的端点。

### 7.2 协议

默认 `POST <baseUrl>/responses`（DeepSeek 等 Coo 端点走 Responses）。遇到 404/405 自动退回 `POST <baseUrl>/chat/completions`，并按端点记住选择。一次请求、一个超时、429/5xx/网络错误重试一次；并发的线程各发各的请求，互不排队。

### 7.3 用量

从响应的 `usage` 里取 `input_tokens` / `output_tokens` / 缓存命中 / 推理 token，映射成 Cortico 的 `LLMUsage`，通过 `WorldHost.reportUsage` 记进本部署的 usage 账本（标签 `线程 tN`）。这样预算、余额、用量面板仍然看得到线程的花费。

### 7.4 为什么不用框架的 provider 模块

直接 import `cortico-provider-coo` 会把这套扩展和 provider 的内部版本绑死；扩展装在被部署的 `data/extensions`，未必能解析到应用目录里的包。用 HTTP 只依赖端点的公开协议，跨版本更稳。代价是少了 provider 的模型目录、计费估算等能力——用量我们自己上报，价格由现有账本按模型算。

---

## 8. 事件协议

线程完成或失败，World 推一条事件（`trigger: 'flush'`）：

```
type:    threads.report / threads.error
source:  threads
text:    [后台线程 t2 完成] 整理下载目录
         <结果正文>
meta:    { thread, title, input, reply } / { thread, title, error }
```

`flush` 的意思是「尽快投递，但不取消主 session 正在进行的模型轮」：主 session 把当前这轮说完，就在下一个轮次边界看到回报。不会因为后台线程干完活而打断正在跟用户说的话。

失败也走同一条路：主 session 知道哪条线程、因为什么失败，可以决定重试、换个说法，或直接告诉用户。

---

## 9. 持久化

`<deployment>/data/threads/state.json`：

```jsonc
{ "version": 1, "seq": 4,
  "threads": [ { "id": "t2", "title": "整理下载目录",
                 "history": [ { "role": "user", "text": "…" },
                              { "role": "assistant", "text": "…" } ],
                 "lastReply": "…" } ] }
```

- 每次任务开始/回复/失败后 400ms 防抖落盘；停 World 时同步落一次。
- 启动时读回，全部按 `idle` 挂回池子；**运行中的任务不自动重跑**（不知道它当时做到哪一步，重跑可能重复副作用），历史保留，等下一次派活。
- 原子写：先写 `.tmp` 再 rename。

---

## 10. 失败模式

| 情况 | 行为 |
|---|---|
| 没配 provider / 没密钥 | 工具调用报错，事件里说清楚；面板显示「端点不可用」 |
| 模型 429 / 5xx / 断网 | 重试一次，再失败按 `threads.error` 回报 |
| 超时 | 中止本次请求，线程回 idle，回报里带超时原因 |
| 池子满 | 按 `onFull` 排队或借用；工具回执里告诉主 session 排第几 |
| 主 session 暂停（没密钥） | 事件照常落库、排队，恢复后投递 |
| 扩展被停用 | `stop()` 先存档再中止全部线程；重新挂载接回历史 |
| 进程重启 | 读回历史，线程全部 idle；未完成的任务不会自动重跑 |
| 回报推不出去 | 记 warn，不影响线程本身 |

---

## 11. 面板与配置

- 面板 `live`：池子读数（忙/闲/排队/上限/保底）、每条线程的状态与最近一句、排队列表、端点信息；每 2 秒拉一次 `snapshot`，可单条停掉。
- 配置组 `world:threads`：`maxThreads`、`reserveIdle`、`onFull`、`historyTurns`、`maxTokens`、`temperature`、`timeoutSec`、`endpoint`、`model`、`apiKeyEnv`，全部热更新。

---

## 12. 为什么不是别的方案

| 方案 | 为什么没走 |
|---|---|
| 改 Core，支持多个接收事件的 session | 侵入框架核心，升级即冲突；Persona/Memory/交接语义都要重做 |
| 多开几个 Coopanion 进程 / 部署 | 每个进程有自己的宠物和记忆，要解决跨进程发言、状态同步、成本翻倍，远超插件边界 |
| 用 `spawnFork` / `cognition` | 这是 Persona 的接口；Cormini 没有实现 `PersonaCognition`，World 调不到 |
| 只在一个 session 里排队 | 没有并行，长任务仍然占住唯一的嘴；不满足「顺便接话」 |
| 让线程直接调 `pet_say` | 线程没有主 session 的输出通道与人格；会变成另一个声音 |

World + 自有模型调用是唯一**不碰框架、又能真并行**的位置。

---

## 13. 边界与后续

现在是刻意留着的：

- **线程没有工具**：不能读工作区、不能 CUA、不能搜网。它们只「想/写/答」。要动手的事仍由主 session 做。下一步如果框架把 World 的工具执行接出来，可以给线程只读工具（读文件、搜索）而不给写工具。
- **线程只看人格摘录**：`CONSTITUTION.md` / `PARTNER.md` 的前 2600 字 + 自己的历史。看不到主 session 的完整上下文——省成本，也避免「它以为自己知道」。
- **不做跨线程记忆**：线程之间不共享上下文；需要共享的东西由主 session 写进工作区，或由 `thread_tell` 转过去。
- **不自动重跑**：重启中断的任务不续跑，避免重复副作用。
- **单进程并发**：模型请求并行，CPU 侧仍是单线程事件循环；线程里不要做重 CPU 计算。

可演进的方向：给线程只读工具、把「线程结果」做成可折叠的结构化摘要、按任务类型路由到不同端点/模型、在面板里支持手动派活与插话。

---

## 14. 验收

- 单元测试 17 项：池子规则（保底、增长、复用、排队、借用、上限、deficit）、线程状态机（完成、插话、失败、dispose、裁剪）、模型客户端（Responses、Chat 回落、401 不重试）。
- 端到端 17 项（假 `/responses` 端点，不花 token）：启动预热保底；三件并发保持 1 闲；第四件排队并在空出来后自动接上；4 条回报；每条都上报用量；插话沿用同一线程；停线程；重启接回存档。
- Cortico `dryMountWorld`：manifest、构造、4 个工具、面板、配置组、提示词文档，0 warning / 0 failure。
- 真实 DeepSeek 端点冒烟：一次 `thread_ask`，拿到回报事件。
- 真实扩展装载器：`loadExtensions` 把包识别为 `world`、API 6、`webUi: served`。
