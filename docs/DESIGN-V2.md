# pi-feishu-bridge V2：Hermes 级飞书桥差异分析与实施路线

> 状态：实施设计（基于 2026-09-05 当前源码）
>
> 目标运行时：`@earendil-works/pi-coding-agent` 0.84.x、Node.js 20+
>
> 对比基线：Hermes `hermes-agent/plugins/platforms/feishu`、生产桥 `pi-feishu-link` 0.2.3、本仓库 `pi-feishu-bridge` 0.1.0
> 历史设计：`docs/DESIGN.md` 保留为 V1 设计与踩坑记录；若与本文冲突，以本文和当前源码为准。

## 1. 结论先行

当前自研桥已经具备正确的核心方向：独立会话、真实回复链、引用原文、bot 身份水合、群策略、WS 重连、处理中反馈。但它仍是“功能原型”，还不是可以长期替代生产桥的可靠消息网关。

差距不主要在功能数量，而在四条闭环尚未成立：

1. **入站不丢**：群非文本消息当前会被批处理路径吞掉；去重状态重启即丢；断线没有补收。
2. **执行不串**：每轮订阅没有释放；超时没有终止 Pi turn；批处理会混合不同用户、话题和引用上下文。
3. **出站必达**：`Outbox` 已创建但未接入发送失败路径；最终回答失败后只记录日志。
4. **交互完整**：没有真实 token 流式回复、审批卡片闭环、媒体下载上传、飞书侧管理命令。

因此不建议先继续堆 UI 功能。实施顺序必须是：

```text
P0 消息正确性和生命周期
  → P0 可靠投递和重启恢复
    → P1 媒体与流式体验
      → P1 审批与远程控制
        → P2 Hermes 扩展能力
```

生产环境在 V2 达到 P0 验收前继续使用 `pi-feishu-link`，新桥只在隔离测试群灰度。

## 2. 目标与边界

### 2.1 V2 目标

- 飞书消息在准入后不静默丢失，并可解释地进入“处理中、成功、失败、待重试”之一。
- 每个确定性 `conversationKey` 对应一个持久 Pi 会话，同 key 串行、不同 key 并行。
- 引用、话题、媒体、工具调用和最终回答均保持正确的消息链关系。
- 临时流式更新可以丢，但最终回答必须经过持久可靠投递。
- 危险工具调用能够在飞书卡片中审批，并校验操作者、会话、过期时间及重复点击。
- 所有关键故障均有结构化日志、状态统计和可执行诊断。

### 2.2 非目标

- 不复制 Hermes 的 Python 网关核心，也不把 5000 行单文件移植到 TypeScript。
- 不调用 Pi 未公开导出的 `AuthStorage`、`ModelRegistry.create` 等内部 API。
- P0 不实现语音转写、Webhook 入站、多平台抽象、在线升级器。
- 不在同一飞书应用上同时运行新旧两个 WS 桥。

## 3. 三方定位

| 实现 | 定位 | 强项 | 主要限制 |
|---|---|---|---|
| Hermes 飞书适配器 | 成熟多平台网关的飞书边缘适配器 | 入站类型完整、持久去重、会话键统一、流式编辑、审批交互、媒体收发、连接监管、测试面广 | 大量能力依赖 Hermes gateway，不能直接复制到 Pi |
| `pi-feishu-link` | 当前生产桥 | Pi 会话适配成熟、持久 outbox、流式卡片、工具/思考转发、审批桥、断线补收、诊断 | 上游归档；mention、引用和消息链有已知缺陷；依赖本地补丁 |
| 自研 `pi-feishu-bridge` | 面向 Pi 的 Hermes 风格新桥 | 结构较小；引用回复、会话隔离、群规则、bot 水合方向正确 | 多项设计只写在文档或留有空壳；可靠性链路没有闭合 |

V2 的策略是：

- **语义和边界参考 Hermes**：消息规范化、mention 优先级、会话键、批处理兼容条件、媒体模型、交互安全。
- **Pi 生命周期参考 feishu-link**：Pi session 包装、一次性订阅、turn supervisor、持久 outbox、live/durable 双通道、permission bridge、missed compensation。
- **保留自研桥的小模块结构**：不引入不必要的通用平台抽象。

## 4. 能力差异矩阵

状态定义：✅ 完整闭环；🟡 部分实现或存在关键缺口；❌ 未实现。

### 4.1 入站与准入

| 能力 | Hermes | feishu-link | 当前桥 | V2 结论 |
|---|---:|---:|---:|---|
| 文本与富文本解析 | ✅ | 🟡 | 🟡 | 保留当前纯函数，补齐 locale/card/post 边界 |
| 图片/文件/音视频下载 | ✅ | ✅ | ❌ | P1 实现真实资源下载与大小限制 |
| 合并转发/共享名片/卡片文本化 | ✅ | 🟡 | 🟡 | 当前仅浅层文本化，需 fixture 验证真实 payload |
| mention ID 优先、名称兜底 | ✅ | ❌ | ❌ | P0 改为 Hermes 的分层优先级，禁止“ID 不同但同名”命中 |
| `@_all` | ✅ | 🟡 | ✅ | 保留 |
| bot 身份在线水合 | ✅ | 🟡（补丁） | ✅ | 保留，增加失败状态与退避 |
| DM/群/每群规则 | ✅ | 🟡 | 🟡 | 修复配置枚举，明确策略层与 mention 层 |
| bot 消息策略 | ✅ 可配置 | ❌ 全拒 | ❌ 全拒 | P2 再评估；默认全拒是安全值 |
| 持久去重 | ✅ | ✅ | ❌ | P0 使用 TTL + 容量 + 原子持久化 |
| 安全批处理 | ✅ | ❌ | ❌ | P0 按 session key 且校验 reply/thread/sender 兼容性 |
| 断线漏消息补收 | ❌/由网关恢复 | ✅ | ❌ | P0 复用 feishu-link 的有界补收思想 |

### 4.2 会话与执行

| 能力 | Hermes | feishu-link | 当前桥 | V2 结论 |
|---|---:|---:|---:|---|
| 确定性会话 key | ✅ | ✅ | ✅ | 统一成唯一 `buildConversationKey()` |
| 群内按用户隔离 | ✅ | 视路由配置 | ✅ | 默认保留 |
| 话题共享/隔离策略 | ✅ | 🟡 | ✅ | 将 `threadSessionsPerUser` 显式配置化 |
| 同会话 FIFO | ✅ | ✅ | ✅ | 保留，改为 Promise tail/受控队列 |
| 跨会话并行 | ✅ | ✅ | ✅ | 保留并增加全局并发上限 |
| 订阅生命周期 | ✅ | ✅ | ❌ | P0 每轮或每 session 单次订阅，必须退订 |
| turn 超时与真正取消 | ✅ | ✅ supervisor | ❌ | P0 调用 Pi 可用的 abort/cancel；不可取消时废弃 handle |
| 队列背压 | ✅ | ✅ | 🟡 | 修复满队列目标、reaction 清理和明确拒绝 |
| 空闲 session 回收 | ✅ | ✅ | ❌ | P1 加 resident cap、idle disposal |
| 崩溃后恢复 | ✅ 持久 ledger | 🟡 | 🟡 | P0 使用可声明、可重放、成功后确认的 pending ledger |

### 4.3 出站与用户体验

| 能力 | Hermes | feishu-link | 当前桥 | V2 结论 |
|---|---:|---:|---:|---|
| 真实 reply 与 thread | ✅ | 🟡 | ✅ | 保留，补齐 thread 回退规则测试 |
| UUID API 幂等 | ✅ | ✅ | ✅ | 保留；重试必须复用 envelope 幂等键 |
| Markdown/post 降级 | ✅ | ✅ | 🟡 | 补齐异常和响应码两种失败 |
| 最终回答可靠投递 | ✅ gateway ledger | ✅ outbox | ❌ | P0 所有 final/error/notify 先入 outbox |
| token 流式输出 | ✅ 编辑消息 | ✅ 卡片 patch | ❌ | P1 做 live channel；final 仍走 outbox |
| thinking/tool 展示 | ✅ gateway stream | ✅ | 🟡 | 当前只有简化工具状态，且命令内容未真正渲染 |
| 处理中 reaction | ✅ | ✅ | 🟡 | 异常、满队列、超时路径均需 finally 清理 |
| 图片/文件/音视频发送 | ✅ | ✅ | ❌ | P1 实现上传与主动回传 |
| 长消息稳定分片 | ✅ | ✅ | 🟡 | 避免拆坏 Unicode、代码围栏和 post 结构 |
| 审批卡片闭环 | ✅ | ✅ | ❌ | P1 实现卡片状态机与工具调用阻塞 |
| 澄清/选择卡片 | ✅ | 🟡 | ❌ | P2 |
| 飞书侧管理命令 | ✅ gateway 命令 | ✅ | ❌ | 当前仅注册 Pi 命令，无入站本地命令路由 |

### 4.4 运行与运维

| 能力 | Hermes | feishu-link | 当前桥 | V2 结论 |
|---|---:|---:|---:|---|
| WS 死亡监管与退避 | ✅ | ✅ | 🟡 | 当前有 watchdog，需消除并发重连和累计计数歧义 |
| 正确关闭旧 WS | ✅ | 🟡（旧 bug 已补） | ✅ | 保留 `close({force:true})`，增加真实关闭验证 |
| 同 app 单实例锁 | ✅ | ✅ | ❌ | P0 防止双桥/双进程消费 |
| 状态持久化 | ✅ | ✅ | ❌ | `statusFile` 已定义但从未写入 |
| 结构化日志 | ✅ | ✅ | 🟡 | 增加 message/run/envelope 关联字段和错误分类 |
| doctor/诊断包 | ✅ | ✅ | ❌ | P2 |
| 密钥文件权限与脱敏 | ✅ | ✅ | 🟡 | `config.json` 写入需 0600；状态/日志不得带 secret |
| 自动化测试广度 | ✅ | ✅ | ❌ | 当前 58 个测试仅覆盖四个测试文件 |

## 5. 已确认缺陷清单

以下不是推测性优化，而是当前代码可以直接证明的问题。

### P0：可能丢消息、串会话或重复处理

| ID | 缺陷 | 代码证据 | 后果 |
|---|---|---|---|
| B-001 | 群批处理分支对所有消息类型提前 `return`，但 `TextBatcher` 拒绝非 text | `src/inbound/pipeline.ts:55-76`、`pipeline-utils.ts:59-69` | 群图片、文件、post 等静默消失 |
| B-002 | 批处理 key 只有 `chatId`，合并时使用最后一条 carrier | `pipeline.ts:64-95` | 不同用户、thread、reply 上下文可被混成一个 turn |
| B-003 | mention 使用 openId/userId/name 的 OR | `normalize.ts:169-180` | ID 明确不同时仍可能因同名误触发；与 Hermes 实现不一致 |
| B-004 | `subscribe()` 每轮注册，返回的 unsubscribe 未保存、未调用 | `conversation-manager.ts:370-420` | 回调泄漏，后续轮次重复接收事件，内存持续增长 |
| B-005 | `lastQuoteBlock` 是 manager 全局字段 | `conversation-manager.ts:93-95,342-344,439` | 并发会话之间相互覆盖清洗上下文 |
| B-006 | 超时只 reject `Promise.race`，没有取消正在运行的 Pi prompt | `conversation-manager.ts:441-447` | 已超时 turn 仍运行，队列可能在同一 session 上启动下一轮 |
| B-007 | reaction 在队列容量检查前添加，错误/超时 catch 不清理 | `conversation-manager.ts:276-285,462-473` | 满队列或失败后永久残留“处理中”表情 |
| B-008 | 队列满时 `notify(key, ...)`，key 可能是 `chat:u:user` 或 `chat:t:thread` | `conversation-manager.ts:249-253,282-285` | 向无效 receive_id 发送，用户看不到背压提示 |
| B-009 | 恢复项强制构造成 group 且丢失 senderId | `conversation-manager.ts:179-196` | `groupSessionsPerUser` 下恢复到 `unknown` 新会话，破坏上下文连续性 |

### P0：可靠投递名存实亡

| ID | 缺陷 | 代码证据 | 后果 |
|---|---|---|---|
| B-010 | `Outbox` 只实例化，没有任何生产调用 `push()` | `src/index.ts:107-111`；全仓仅定义 `outbox.ts:45` | 最终回复失败后不会重试 |
| B-011 | 已加载的 outbox 条目不会自动调度；只有新 `push()` 才 `schedule()` | `outbox.ts:37-49,94-109` | 重启后历史失败条目不投递 |
| B-012 | 所有发送失败都被压成 `success:false`，没有 retryable/fatal 分类 | `sender.ts:157-180` | 无法决定重试、降级或永久失败 |
| B-013 | 发送成功后 30 秒 timeout timer 未取消 | `sender.ts:205-209` | 每次 API 调用保留句柄；测试 58 项虽通过但进程耗时约 30 秒才退出 |
| B-014 | pending 恢复先清空整个文件，再逐条重放 | `conversation-manager.ts:162-197` | 恢复过程中再次崩溃会永久丢掉未处理项 |

### P1：功能声明与真实实现不一致

| ID | 缺陷 | 代码证据 | 后果 |
|---|---|---|---|
| B-015 | 图片/音视频/文件仅生成文字占位，没有资源下载和 `images` 传递 | `normalize.ts:279-297`、`conversation-manager.ts:74-85` | Pi 看不到实际附件 |
| B-016 | 配置类型声明 `blacklist/admin_only`，解析器却不接受 | `types.ts:8`、`config.ts:26-29` | env/groupRules 中策略被静默忽略 |
| B-017 | `approval` 只有配置，无卡片事件、状态机、tool gate | `types.ts:54`、`transport.ts:102-111` | 危险命令无法在飞书审批 |
| B-018 | 当前是 embedded extension，没有 V1 设计中的 daemon host/app lock | `src/index.ts:35-145` | 主会话生命周期与桥耦合，误启两个实例时可能重复消费 |
| B-019 | `statusFile` 定义但无写入调用 | `config.ts:10-23` | 外部健康检查读不到新桥权威状态 |
| B-020 | `lastCmd` 被记录但 `renderProgress()` 没渲染 | `conversation-manager.ts:114-139` | 注释声称显示真实命令，用户界面实际看不到 |

## 6. V2 目标架构

```text
Feishu WS
  │
  ▼
TransportSupervisor
  ├─ app lock / connect / close / reconnect / health
  ├─ bot identity hydration
  └─ missed-message compensation
  │ raw event
  ▼
InboundPipeline
  ├─ normalize + resource references
  ├─ persistent dedupe
  ├─ admission
  ├─ session-scoped compatible batching
  ├─ quote/thread resolution
  └─ durable inbound claim
  │ InboundEnvelope
  ▼
ConversationManager
  ├─ buildConversationKey() 唯一真源
  ├─ per-key FIFO + global concurrency cap
  ├─ PiSessionHandle lifecycle
  ├─ turn cancellation / timeout / disposal
  └─ structured AgentEvent adapter
  │
  ├──────────────► LiveChannel（易失）
  │                 token/tool/thinking 合并、节流、编辑
  │
  └──────────────► DurableOutbox（权威）
                    final/error/notify/media
                    per-lane FIFO、幂等、退避、重启重放
```

### 6.1 核心不变量

1. **先持久化后确认**：入站 claim 和最终出站 envelope 必须先落盘，再改变完成状态。
2. **一个会话键函数**：准入后的 batching、session、outbox lane、审批都使用同一个 `conversationKey`。
3. **同 key 串行**：一个 key 同时最多一个 active turn；超时后只有在旧 handle 已取消或废弃后才能运行下一条。
4. **订阅有所有者**：每个订阅必须有确定释放点；禁止在每轮无条件累积订阅。
5. **live 不承载正确性**：流式编辑失败不影响 final；final 必须由 outbox 对账。
6. **ID 优先**：mention 两侧都有同层 ID 时，ID 不同即不匹配，不允许再用名称翻案。
7. **不可静默丢弃**：除 dedupe/admission 外，所有拒绝、容量溢出和永久失败必须记录 reason 与关联 ID。
8. **关闭可证明**：停止桥后不得残留 WS、timer、subscription、active turn 或处理中 reaction。

### 6.2 建议模块调整

```text
src/
├── inbound/
│   ├── normalize.ts
│   ├── resources.ts          # 新增：下载、大小/MIME 限制、临时文件生命周期
│   ├── dedupe-store.ts       # 替换内存 DedupCache
│   ├── batcher.ts            # 按 conversationKey + 兼容条件
│   └── pipeline.ts
├── session/
│   ├── conversation-key.ts   # 唯一 key 生成器
│   ├── conversation-manager.ts
│   ├── pi-session-backend.ts
│   └── turn-supervisor.ts    # 超时、取消、ack、队列状态
├── outbound/
│   ├── sender.ts             # 单次 API 原语 + 错误分类
│   ├── durable-outbox.ts     # 权威投递
│   ├── live-channel.ts       # 易失流式编辑
│   └── renderer.ts           # text/post/card/media
├── approval/
│   ├── permission-bridge.ts
│   └── card-actions.ts
├── host/
│   ├── transport-supervisor.ts
│   ├── app-lock.ts
│   └── status-store.ts
└── commands/
    └── router.ts
```

不要求一次性完成目录重构。每个阶段只在对应逻辑需要修改时提取模块。

## 7. 分阶段实施计划

### P0-0：建立能抓住生产 bug 的测试基线

目标：先让已确认缺陷变成失败测试，避免旧基线“58/58 绿但生产不可用”。

任务：

1. 增加 `conversation-manager.test.ts`、`transport.test.ts`、`outbox.test.ts`、`config.test.ts`。
2. 使用 fake clock；所有 timeout 必须 `unref` 或在 settle 后取消。
3. 增加句柄泄漏门：测试结束后无活动 timer/subscription。
4. 将测试脚本改为自动发现 `tests/**/*.test.ts`，避免新增测试忘记注册。
5. 固化真实飞书 payload fixture，但删除 open_id、chat_id、消息正文等敏感值。

验收：

- B-001、B-003、B-004、B-006、B-010、B-013 至少各有一个红测试。
- `npm test` 在 5 秒内退出，而不是等待 30 秒 timer。
- `npm run typecheck` 通过。

### P0-1：修复入站丢失与错误合并

目标：所有准入后的消息要么分发，要么有明确错误。

任务：

1. 只有 `msgType === "text"` 才进入 text batcher；媒体和命令立即分发。
2. 新增 `buildConversationKey(msg, config)`，pipeline 与 manager 共用。
3. batch key 使用 conversationKey；仅当 sender、thread、reply target、reply text、消息类型一致时合并。
4. 遇到不兼容消息先 flush 旧窗口，再建立新窗口。
5. 加 `maxMessages`、`maxChars`，防止突发消息无限增长。
6. stop 时 flush 或显式记录被取消窗口，禁止无声清空。

验收矩阵：

- 群图片、post、文件均立即 dispatch。
- 同群不同用户不合并；主聊天与 thread 不合并；回复不同消息不合并。
- 同一用户连续短文本按配置合并。
- 关闭桥时无未解释的 batch 丢失。

### P0-2：修复 mention 与准入配置

目标：既不漏掉真实 @，也不因同名误触发。

任务：

1. 实现 Hermes 优先级：`open_id > user_id > name`；只有任一侧缺当前层 ID 才降级下一层。
2. `@_all` 独立处理；post `<at>` 与事件 `mentions` 使用同一标准化结构。
3. `parseGroupPolicy()` 支持全部类型值，非法配置启动时明确报错，不静默忽略。
4. 保留两层模型：policy 决定谁能用，`requireMention` 决定本条是否唤醒；admin 只豁免 policy。
5. `groupAlsoOnReply` 只能在回复目标被可靠判定为本 bot 消息时免 @。

验收：

- open_id 不同、名称相同：拒绝。
- open_id 缺失、名称相同：允许兜底。
- `blacklist/admin_only` 可从文件和 env 正确加载。
- 表驱动覆盖 DM、admin、allowlist、blacklist、disabled、reply、`@_all`。

### P0-3：收紧 Pi session 生命周期

目标：一个 turn 的事件只处理一次，超时后不留下幽灵执行。

任务：

1. 每轮订阅必须在 `finally` 调用 unsubscribe；或改成 session 生命周期只挂一次、事件按 run token 路由。
2. `lastQuoteBlock` 移入 `runOne()` 局部作用域。
3. timeout timer 在成功、失败、取消全部清理。
4. 扩展 `SessionBackend` 暴露 Pi 官方支持的 `abort/cancel/dispose`；超时先终止 turn，再继续队列。
5. 若当前 Pi 版本没有可靠 abort：立即 dispose handle，下一轮从 session 文件重开，禁止复用仍在运行的对象。
6. 队列容量检查在添加 reaction 前；所有 reaction/progress 清理统一放在最外层 `finally`。
7. 队列拒绝通知始终发送到 `sess.chatId`，thread 场景带 `threadId`。
8. 增加全局 active session 上限，防止大量群同时耗尽模型连接。

验收：

- 连续 100 轮后 subscription 数稳定。
- 人为超时后旧 turn 不再发消息，下一条能正常执行。
- prompt 抛错、发送失败、队列满、shutdown 后均无残留 reaction/progress。
- 同 key 严格串行，不同 key 可并行。

### P0-4：重建最终回答可靠投递

目标：最终回答不再依赖一次网络请求成功。

任务：

1. 将 sender 拆成“API 单次发送原语”和“durable outbox”。
2. `final/error/notify/media` 一律先写 envelope，再由 outbox 发送。
3. envelope 包含：稳定 id、dedupeKey、laneKey、route、payload、attempts、nextRetryAt、状态、错误类别。
4. 同 conversation lane FIFO；不同 lane 有受控并发。
5. retryable：网络错误、timeout、429、5xx；fatal：鉴权、无权限、非法目标；内容错误先 renderer 降级再决定。
6. 重试使用退避、抖动和 `Retry-After`；API UUID 在同 envelope 重试中保持稳定。
7. 启动时把 `sending` 恢复为 `pending` 并自动 pump；terminal envelope 不重复发送。
8. 容量、单条大小、目录总大小和保留期均设上限；超限明确告警。
9. 修复 request timeout timer：请求 settle 后立即 clear。

验收：

- 进程在发送前、发送中、成功记录前分别 kill，重启后最终结果至多可见一次。
- 429/5xx/网络断开自动重试；fatal 不无限重试。
- 同一会话的多条回复顺序不反转。
- `status` 能显示 pending/sending/sent/failed/lanes/oldestAge。

### P0-5：持久入站去重、恢复与连接单实例

目标：重连和重启不重复处理，也不遗漏短时断线消息。

任务：

1. 将 `DedupCache` 替换为带 TTL、容量限制和原子持久化的 `DedupeStore`。
2. pending ledger 保存完整 conversationKey、chatType、senderId、thread/reply/media refs，不再重建为 `unknown`。
3. pending 使用 claim/ack：恢复前不清空；单条成功后确认。
4. 增加 appId 作用域进程锁，陈旧 PID 可回收。
5. TransportSupervisor 保证任意时刻最多一个 reconnect；记录 downSince。
6. 重连成功后对已知 chat 做有界历史补收：时间窗口、每群上限、dedupe 先行、权限失败降级。
7. 实际写入 `status.json`，采用临时文件 + rename，内容不含密钥。

验收：

- 同一事件跨重启重放只执行一次。
- 恢复过程二次崩溃后仍可再次恢复。
- 两个进程使用同 appId 时第二个 fail-fast，不建立 WS。
- 模拟 10 秒断线后，窗口内遗漏消息可补收；超限有统计。

完成 P0 后才允许在测试群替换旧桥。

### P1-1：真实媒体入站与出站

目标：Pi 能看到图片和文本附件，生成文件能回到飞书。

任务：

1. 标准化结果保存 `ResourceRef`，不把 `image_key/file_key` 假装成可访问 Markdown URL。
2. 下载前校验类型、数量和声明大小；下载后再校验实际大小与 MIME。
3. 图片转为 Pi `images` 输入；UTF-8 文本文件有界提取；其他文件提供本地路径与安全元数据。
4. 临时资源按 turn/session 生命周期清理，文件名规范化，禁止路径穿越。
5. 实现图片、文件、视频、Opus 音频上传；不支持转码时按普通文件降级。
6. 媒体 final 也经 outbox，上传 key 与消息发送分阶段记录。

验收：

- 群/私聊图片可被模型识别。
- txt/md/json 在字符上限内可读；超大/未知文件给出明确提示。
- Agent 生成的图片和文件可回传。
- 临时目录无跨 turn 泄漏。

### P1-2：Hermes 式流式回复与工具过程

目标：首 token 快速可见，长任务持续有进展，最终结果可对账。

任务：

1. 新增 `AgentEventAdapter`：统一 `text_delta/reasoning_delta/tool_start/tool_end/turn_end`。
2. 新增易失 `LiveChannel`：按 run/card 合并 delta、节流编辑、失败熔断。
3. 第一次内容创建 reply 消息，后续编辑同一消息；过长时安全分段。
4. thinking 默认不展示原始隐式推理；只展示模型明确提供、配置允许的 reasoning 摘要。
5. 工具过程使用状态摘要；命令参数按安全规则截断、脱敏，禁止泄漏 env/token。
6. turn_end 创建 durable final envelope；最终内容覆盖/补发，确保流式丢 patch 也能收敛。
7. 无输出和 intentional silence 不发送伪造完成文本。

验收：

- 流式网络错误后仍收到完整 final。
- 工具多轮只发送最终答案，不把中间 assistant tool-use 文本当最终答复。
- Markdown 代码围栏在每次编辑中保持可渲染。
- 流式关闭时行为退化为单条可靠 final。

### P1-3：审批卡片和远程控制闭环

目标：危险操作在飞书中可安全批准或拒绝。

任务：

1. 在 transport 注册 `card.action.trigger`。
2. 新增 `PermissionBridge`，分类 `allow/ask/deny`，支持 once/session/always/deny。
3. pending approval 绑定 approvalId、conversationKey、runId、tool、操作者范围、messageId、expiresAt。
4. 点击时校验：卡片来源、chat、管理员身份、pending 状态、TTL、防重放 token。
5. 原子消费第一次有效点击，重复点击幂等；更新卡片为最终状态。
6. 超时默认 deny，并解除等待中的工具调用。
7. approval boundary 与流式输出串行，不能让工具进度和审批卡竞态更新同一消息。
8. 所有决策写审计日志；敏感参数脱敏。

验收：

- 非管理员点击无效；跨群/过期/重复点击无效。
- approve once 只影响一次；session 仅影响当前 conversationKey。
- timeout 后工具不执行，Agent 能收到结构化拒绝结果。
- restart 后旧卡不会错误批准新 run。

### P1-4：飞书侧命令与可观测性

目标：不进容器也能诊断和控制桥。

首批命令：

- `/feishu status`：连接、bot、会话、队列、outbox、最近错误。
- `/feishu doctor`：权限、bot 水合、WS、文件权限、session/outbox 可写性。
- `/help`、`/commands`：列出飞书端支持的命令、参数与忙碌语义。
- `/new`、`/stop`、`/compact`：当前会话控制；`/stop` 中止当前 run，但保留显式 follow-up 队列。
- `/steer <内容>`：对齐 Pi steer，在当前 assistant turn/工具批次结束后注入当前 run。
- `/queue <内容>`、`/q <内容>`：当前 run 完整结束后执行独立 FIFO turn。
- `/model`：查看/选择当前会话模型；尚无 Pi session 时先完成懒初始化，不能返回“当前会话尚未建立”。
- `/feishu policy`：仅管理员，修改单群规则并原子落盘。

要求：

- 命令在入站 pipeline 中显式路由，不依赖 Pi 是否把斜杠文本当普通 prompt。
- 管理命令沿用同一权限模型；不能通过伪造 senderName 获权。
- 日志统一包含 `messageId/conversationKey/runId/envelopeId`，正文只记录长度和截断摘要。

### P2：完善 Hermes 级边缘能力

按实际需求逐项启用，不阻塞生产替换：

1. 澄清/选择交互卡片。
2. 语音转写及语音回复。
3. Webhook 入站模式与签名、body 上限、IP/速率保护。
4. channel prompt、每群模型和工作区配置。
5. session idle eviction、resident cap、历史会话选择。
6. 主动通知 API、定时任务路由。
7. 诊断包导出、敏感字段净化。
8. 国际化和 Lark 域完整验证。

## 8. 推荐实施切片

每个切片都必须可独立合并、回滚和验证，禁止一次“大重写”。

| 顺序 | 切片 | 主要文件 | 合并门槛 |
|---:|---|---|---|
| 1 | 测试自动发现 + timer 清理 | `package.json`、sender tests | 测试 <5s 退出 |
| 2 | 非文本不进 batch | `pipeline.ts` | 群媒体不丢测试 |
| 3 | conversationKey + 兼容批处理 | 新 key 模块、batcher | 跨用户/thread/reply 不混 |
| 4 | mention 优先级 + 配置校验 | `normalize.ts`、`config.ts` | 表驱动矩阵 |
| 5 | 订阅释放 + reaction finally | manager | 100 轮无增长 |
| 6 | turn cancel/dispose | backend、supervisor、manager | 超时无幽灵输出 |
| 7 | durable outbox 接管 final | sender、outbox、manager | kill-point 恢复测试 |
| 8 | persistent dedupe/pending/app lock | inbound、host | 重启/双实例测试 |
| 9 | missed compensation/status | transport supervisor | 断线恢复测试 |
| 10 | 媒体入站 | resources、pipeline、backend | 图片识别实测 |
| 11 | live streaming + final reconcile | live channel、events | 故障降级实测 |
| 12 | 审批闭环 | approval、transport | 安全矩阵 |
| 13 | 命令与 doctor | commands、status | 测试群远程诊断 |

## 9. 测试与验收体系

### 9.1 单元测试

- normalize：所有 msg type、locale post、mention precedence、恶意/损坏 JSON。
- admission：策略层 × mention 层笛卡尔矩阵。
- batch：key、兼容条件、大小/数量、timer、stop。
- session：FIFO、跨 key 并行、订阅释放、超时、取消、handle 重开。
- sender：reply/create/thread、post 降级、429/5xx/fatal、timeout 清理。
- outbox：重启恢复、幂等、lane 顺序、容量、损坏尾行、compaction。
- approval：授权、TTL、重复点击、跨会话重放。

### 9.2 组件集成测试

- Fake Lark SDK：`receive_v1 → normalize → admit → session → outbox → reply`。
- Fake Pi session：多轮 tool-use、文本 delta、异常、永不结束、迟到事件。
- 临时目录重启：dedupe、pending、session、outbox 全部重新加载。
- Fake clock + deterministic UUID，避免真实等待。

### 9.3 真实飞书灰度矩阵

| 场景 | 预期 |
|---|---|
| 群内不 @ | mention 群沉默并记录 admission reason |
| 群内 @ / `@_all` | 只触发一次 |
| 回复 bot、不 @ | 按配置触发并注入正确原文 |
| 回复他人、不 @ | 不误判为回复 bot |
| 主聊天与话题并发 | 会话和回复链不串 |
| 两个用户同时发送 | 按配置隔离，内容不混合 |
| 图片、post、文件、合并转发 | 不丢；支持项进入 Pi，不支持项明确提示 |
| 长回答和多次工具调用 | 流式稳定、只形成一个权威 final |
| 撤回被回复消息 | thread 安全降级，不意外创建新话题 |
| 处理中断网/重启 | 无永久“处理中”，final 可恢复 |
| 危险命令 | 卡片审批；越权/过期点击无效 |
| 双桥误启 | 第二实例 fail-fast |

## 10. 发布与回滚

### 10.1 灰度门槛

新桥必须同时满足：

- P0 全部自动化测试通过。
- `npm test`、`typecheck` 无悬挂句柄。
- 连续 24 小时测试群运行，无静默丢消息、重复 final、残留 reaction、WS 泄漏。
- 至少完成一次发送中 kill、WS 断线、Pi turn 超时、容器 restart 演练。
- `status.json`、日志和 `/feishu doctor` 对同一状态给出一致结论。

### 10.2 切换

1. 确认旧桥 outbox 已 drain。
2. 停止旧桥并确认 WS 已关闭。
3. `settings.json` 只保留一个飞书桥 package。
4. 启动新桥，验证 app lock、bot 水合、WS ready、测试群收发。
5. 逐个开放 allowChats，不一次性开放所有生产群。

### 10.3 回滚

1. 停止新桥并确认 WS/active turn 已关闭。
2. 保存新桥 session/outbox 状态，不删除。
3. `settings.json` 切回 `npm:pi-feishu-link`。
4. 重启后检查旧桥 `connState=connected`、daemon 单实例、outbox 正常。
5. 对切换窗口消息做人工对账，避免两个桥分别处理一半。

## 11. 关键设计取舍

### 11.1 为什么不直接复制 Hermes adapter

Hermes 的流式、session、restart recovery、delivery ledger、命令系统很大一部分位于通用 gateway，而不在飞书 adapter 内。逐行移植 adapter 会得到大量缺失宿主语义的代码。V2 只复制协议语义和已验证的不变量，在 Pi 官方 API 上重新闭环。

### 11.2 为什么 outbox 优先于流式卡片

流式只改善等待体验，outbox 决定最终答案能否送达。正确结构是 feishu-link 的双通道：live patch 可以丢，final 必须持久化并最终对账。先做流式会继续掩盖发送失败。

### 11.3 daemon 还是 embedded

P0 先把 embedded 模式做正确，因为当前部署就是该路径。完成 app lock、完整 shutdown 和状态持久化后，再用故障注入决定是否需要 daemon 隔离。daemon 不是可靠性的替代品；若其引入双 Pi 生命周期和事件归属不清，宁可继续 embedded。

### 11.4 pending 与 outbox 的关系

- pending ledger 回答“这个用户 turn 是否已经完成”。
- outbox 回答“这个 turn 的结果是否已经送达”。

二者不能用一个布尔值替代。Agent 已完成但 final 未送达时，必须只重投 final，不能重新运行 Agent。

## 12. 源码证据索引

### 当前桥

- 入口与装配：`src/index.ts:35-312`
- 入站 pipeline：`src/inbound/pipeline.ts:27-131`
- mention/消息规范化：`src/inbound/normalize.ts:151-329`
- 会话与 turn：`src/session/conversation-manager.ts:89-511`
- Pi backend：`src/session/pi-session-backend.ts:35-84`
- sender：`src/outbound/sender.ts:108-210`
- outbox：`src/outbound/outbox.ts:30-127`
- 当前测试入口：`package.json` 的 `scripts.test`

### Hermes

- mention ID 优先：`hermes-agent/plugins/platforms/feishu/adapter.py:243-257`
- 标准化与媒体引用：同文件 `613-670`
- send/edit/approval/media：同文件 `1556-1823`
- 入站处理与 thread/reply：同文件 `2489-2552`
- 兼容批处理：同文件 `2800-2844`
- 群策略与身份水合：同文件 `3251-3396`
- 持久去重：同文件 `3398-3455`
- WS supervisor/send retry：同文件 `3643-3791`
- 会话 key 唯一真源：`hermes-agent/gateway/session.py:641-682`
- 流式 consumer：`hermes-agent/gateway/stream_consumer.py:1-190`

### feishu-link

- 入站准入与附件：`feishu-refs/pi-feishu-link/src/application/message-handler.ts:113-275`
- 会话 FIFO 与订阅释放：`.../sessions/conversation-manager.ts:142-209`
- durable final 转发：`.../outbound/event-forwarder.ts:51-122`
- 易失 live channel：`.../outbound/live-channel.ts:27-133`
- 持久 outbox：`.../outbound/outbox.ts:105-340`
- 审批桥：`.../sessions/permission-bridge.ts:138-251`
- 断线补收：`.../inbound/missed-compensation.ts:46-104`
- 持久去重：`.../common/dedupe-store.ts:16-109`

## 13. 完成定义

“达到 Hermes 级 Pi 飞书桥”不是指功能表打满，而是以下结果同时成立：

1. 所有 P0 不变量有自动化故障测试证明。
2. P1 媒体、流式、审批形成端到端闭环。
3. 真实飞书灰度矩阵全部通过并留下运行证据。
4. 旧桥可以下线，但仍保留可执行回滚手册和一次演练记录。
5. 设计文档、配置示例、实现和测试保持一致，不再出现“文档写了、代码有空壳、测试未覆盖”的状态。

## 14. 实施状态（2026-09-06）

当前已完成 P0、P1 的代码与本地自动化验收，生产已切换 V2，真实 WS 初始连接稳定；消息矩阵、故障注入、24 小时观察和回滚演练仍未完成。详细验收记录见 `docs/ACCEPTANCE-V2.md`。

| 阶段 | 状态 | 已验证证据 |
|---|---|---|
| P0-0 | 已完成 | 测试自动发现；`npm test` 159/159，约 4.2 秒退出；typecheck 通过 |
| P0-1 | 已完成 | 非文本直通、共享 conversationKey、兼容合并、容量与 stop flush 测试 |
| P0-2 | 已完成 | mention ID 优先、全策略解析、非法配置 fail-fast、准入矩阵测试 |
| P0-3 | 已完成 | 100 轮订阅稳定、abort/dispose、全局并发上限、shutdown 不续跑排队项及外部调用有界清理测试 |
| P0-4 | 已完成（本地） | durable final/error/notify、稳定 UUID、lane FIFO、重试分类/容量；真实子进程在发送前/接收后 SIGKILL 并恢复同 UUID |
| P0-5 | 已完成（本地） | 持久 dedupe/pending/known chats、两个真实 PID 竞争 app lock、重连/stop 互斥、有界补收与截断统计 |
| P1-1 | 已完成（本地） | 声明/实际大小和 MIME 校验、二进制防伪装、工作区/spool/TOCTOU 边界、媒体 checkpoint 与原生类型降级 |
| P1-2 | 已完成（本地） | Agent turn_end、节流编辑/熔断、live-final 串行交接、Markdown 围栏、命令脱敏、durable final 收敛测试 |
| P1-3 | 已完成（本地） | 卡片 action、管理员/会话/run/token/TTL 校验、旧卡失效、卡片发送挂起超时、文件外发默认审批、审计关联字段 |
| P1-4 | 已完成（本地） | 普通消息 steer、显式 steer/queue/stop、命令帮助、队列/审批 status、doctor、模型切换、策略原子落盘与运维状态防假阳性 |
| 真实灰度 | 进行中 | 已停旧桥、启 V2 并确认 WS 稳定；消息矩阵、故障注入、24 小时观察和回滚演练仍待执行 |

P0/P1 本地验收命令：

```bash
npm test
npm run typecheck
git diff --check
```
