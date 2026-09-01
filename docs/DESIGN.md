# pi-feishu-bridge 设计文档（DESIGN.md）

> 版本：0.1 草案 · 2026-09-02
> 状态：设计基线（实现以本文档为唯一事实来源，偏差需回写本文档）

## 1. 背景与目标

### 1.1 为什么要新建这个桥

生产桥 `pi-feishu-link`（v0.2.3，上游已归档）存在三类被实测/代码确认的缺陷：

| # | 缺陷 | 代码根因 | 用户可感知后果 |
|---|---|---|---|
| B1 | 回复消息拿不到 | `isReplyToBot` 用 `router.getRoute(key).lastMessageId === parentId` 内存态猜测；群回复不带 @ 时直接被 `drop_grouppolicy` 丢弃；从不拉取被回复原文 | 用户回复 bot 的消息偶发完全无响应 |
| B2 | @mention 判定脆弱 | 只认 `mention.id.open_id === botOpenId`；转发/合并转发消息的 mention 元数据缺 open_id 时误判；botOpenId 依赖 env 与初始化时序（上游 bug 靠补丁救） | 转发的消息该收不收、该拒不拒 |
| B3 | 会话链路（消息链）错误 | 单链 route（per-chat lastMessageId）无 thread 概念；发送不挂真实回复；失败无回退 | 消息链在客户端显示错乱、话题消息丢失 |

### 1.2 参考实现（feishu-refs/ 与 hermes-agent/）

| 参考 | 采纳的设计点 |
|---|---|
| `hermes-agent/plugins/platforms/feishu/adapter.py`（5915 行） | mention 判定（ID 优先 + name 兜底 + `@_all`）；bot 身份水合（/open-apis/bot/v3/info）；回复解析（parent_id/upper_message_id/root_id + 拉取被回复原文）；文本批量合并；message_id 去重；每群规则（policy/allowlist/blacklist/require_mention）；真实 reply API + uuid 幂等 + 撤回回退；话题（thread_id）透传 |
| `pi-feishu-link`（当前生产桥） | daemon 常驻模式（extension 内 spawn headless `pi --mode rpc`，`tail -f /dev/null | exec pi` 保活）；per-chat `createAgentSession`（PiSessionBackend）；outbox 错误分类；missed-compensation；工具审批卡片；`groupPolicyByChat` per-chat 策略 |
| `pi-remote-feishu/ARCHITECTURE.zh-CN.md` | ConversationRouter → SessionHostManager → `Map<sessionKey, SessionHost>`：每个会话独立 runtime/queue，杜绝跨会话串线（B3 根治） |
| `pi-feishu-lark` / `pi-feishu` / `pi-channels` / `pi-feishu-notify` | 均为参考；pi-feishu-lark 的 SDK API 兼容性失败教训（`AuthStorage.create()`/`ModelRegistry.create()` 不存在于官方 pi 0.8x —— **新桥只使用官方 pi 0.84.4 确认导出的 API**，见 §7.2） |

### 1.3 设计原则

1. **消息完整性优先**：宁收勿漏。准入（allowlist/mention）是唯一丢弃点，且全部可配置。
2. **回复是头等公民**：回复消息必须被识别、原文必须可见、回复必须挂在真实消息链上。
3. **每会话隔离**：一个 chat（或 thread）一个 agent session，互不串线。
4. **幂等**：发送带 uuid（API 层幂等），接收按 message_id 去重。
5. **可回滚**：与 pi-feishu-link 完全独立命名与端口，切换一键，回滚零残留。
6. **只依赖官方 pi API**：全部 SDK 调用以 pi 0.84.4 的 `index.d.ts` 导出为唯一契约（见 §7.2 契约表）。

## 2. 架构总览

```
┌────────────────────────── 容器 dm-pi-agent ──────────────────────────┐
│                                                                       │
│  pi --mode rpc（主进程）                                              │
│  └─ extensions: pi-feishu-bridge（本扩展）                            │
│       ├─ host/daemon-host.ts    常驻守护（spawn headless pi 或直连）  │
│       ├─ inbound/transport.ts   飞书 WS 长连（lark SDK）＋重连/退避    │
│       ├─ inbound/pipeline.ts    规范化→去重→批量→准入→回复解析         │
│       ├─ session/conversation-manager.ts  Map<key, BridgeSession>     │
│       │     └─ session/pi-session-backend.ts  createAgentSession      │
│       ├─ outbound/sender.ts     reply API＋uuid 幂等＋chunking＋回退   │
│       ├─ outbound/outbox.ts     失败重试/错误分类                     │
│       ├─ commands/              /feishu status/start/stop/…           │
│       └─ gateway-lock.ts        僵尸锁清理（复用 pi-feishu-link 方案）│
└───────────────────────────────────────────────────────────────────────┘
```

### 2.1 两种运行模式（部署时二选一）

- **模式 D（daemon，推荐，复刻 pi-feishu-link）**：extension 在容器主 pi 进程加载后，`daemon-host` spawn 一个独立的 `pi --mode rpc --no-extensions-…` 子进程常驻；WS 与会话管理全部在子进程内，与交互会话隔离，崩溃互不影响。容器 entrypoint 已有此模式先例。
- **模式 E（embedded）**：直接在主 pi 进程内跑 WS + 会话。适合本地单用户调试。
- 两种模式共享 100% 的 inbound/outbound/session 代码，仅 host 层不同。

### 2.2 会话模型（B3 根治）

```
ConversationRouter
  └─ ConversationManager: Map<conversationKey, BridgeSession>
        conversationKey = chat_id (thread 消息并入 chat 的同一 session，事件带 thread 标记)
        BridgeSession = { agentSession(createAgentSession), queue, activeRun, lastReplyId, outbox }
```

- 每个 chat 独立 `createAgentSession`（SDK：`SessionManager.open(sessionFile)` + `createAgentSession`），会话文件按 chat 持久化（`sessions/feishu/<chat_id>.jsonl`）。
- 同一 chat 的消息串行进入 queue；不同 chat 完全并行。
- 回复链：入站解析出 `reply_to_message_id` 与 `reply_to_text` → 注入提示词（`> 回复对象原文：…`）→ agent 感知上下文；出站 `send(chat, text, replyTo=lastMessageId)` 挂真实回复。

## 3. 模块设计

### 3.1 host/daemon-host.ts

- `spawnDaemon(opts)`：`bash -lc 'tail -f /dev/null | exec pi --mode rpc …'`，进程组隔离，pid 记录到 gateway-lock。
- `gateway-lock`：`feishu-bridge/status.json` 记录 pid/startedAt；启动时校验 pid 存活，死锁自动清理（复刻 pi-feishu-link gateway-lock.ts 的僵尸锁修复 2026-08-07）。
- `uninstallWatch`：包被卸载时清理锁与子进程。

### 3.2 inbound/transport.ts（WS 长连）

- 依赖 `@larksuiteoapi/node-sdk`（与 pi-feishu-link 同款，已验可用）：`Client` + `WSClient` + `EventDispatcher`。
- 事件注册：`im.message.receive_v1`（主）、`im.message.message_read_v1`、`im.message.recalled_v1`、`im.chat.member.bot.added_v1/removed_v1`、`card.action.trigger`（审批卡片）、`im.message.reaction.created_v1`（处理中 emoji，可选）。
- 错误分类（复刻 pi-feishu-link transport）：retryable（网络/5xx/WS 断开）→ 指数退避（1s→60s，抖动）；fatal（鉴权失败/配置错）→ 停桥并报告。
- **bot 身份水合**（hermes 设计）：WS 连接成功后调 `GET /open-apis/bot/v3/info`（tenant token，无需额外权限），取 `bot_open_id`/`bot_name` 缓存；env 提供的值仅作启动前兜底，水合结果优先。→ B2 根因消除（不依赖初始化时序）。

### 3.3 inbound/pipeline.ts（规范化流水线）

顺序：`normalize → dedup → batch → admit → reply-resolve → dispatch`

1. **normalize**：文本/图片/视频/语音/文档/合并转发(merge_forward)/共享名片(share_chat)/卡片(post/interactive)。合并转发递归展开为列表（hermes `_collect_forward_entries`）。富文本（post payload）→ markdown（`_render_post_element` 思路）。
2. **dedup**：LRU 缓存 message_id（容量 4096），重复直接丢。→ 与 WS 重连/双通道无关地保证幂等。
3. **batch**（可配置开关）：同一 chat 3 秒窗口内多条 text 合并为一条（换行拼接），转发拆条自动合并（hermes `_text_batch_*`）。
4. **admit（准入）**：见 §4 群策略。仅此处允许丢弃。
5. **reply-resolve**：`reply_to_message_id = parent_id ?? upper_message_id ?? root_id`；若存在 → 调 `GET /open-apis/im/v1/messages/{id}` 拉原文（缓存 5min，失败降级为占位文本），得到 `reply_to_text`。→ B1 根因消除。
6. **dispatch**：`ConversationManager.route(message)` → 入队 → agent 处理。

### 3.4 session/pi-session-backend.ts + conversation-manager.ts

- 复刻 pi-feishu-link 的 `PiSessionBackend`（已验证可用的 SDK 调用方式）：`SessionManager.open(file)` → `createAgentSession({session, sessionManager, cwd})` → `session.prompt(text, {images})` → `session.subscribe(fn)` 流式事件（tool 开始/结束、流式增量、turn 完成）。
- `BridgeSession`：`queue`（串行）、`activeRun` 守卫（同一 chat 并发消息排队；超时 300s 通知"任务处理超时请重试"）、`sessionFile` 持久化。
- 会话恢复：容器重启后 `SessionManager.open` 续接旧会话文件（历史上下文保留）。

### 3.5 outbound/sender.ts（发送核心，B1 出站侧根治）

```
send(chatId, content, { replyTo?, threadId? }):
  1. format_message：markdown 优化（代码块/表格 → post 富文本；检测失败退 text）
  2. truncate_message chunking（MAX_MESSAGE_LENGTH=16384），markdown 判定锁定在整条消息级（防跨 chunk 渲染错乱，hermes #26841 教训）
  3. 逐 chunk：msg_type=post/text → im.v1.message.reply（replyTo 存在时）或 im.v1.message.create
     - reply 请求带 uuid（API 幂等）
     - reply_in_thread=threadId 存在时
  4. 失败处理：
     - post 内容非法 → 降级 text 重发
     - reply 失败且 code ∈ {撤回/不存在}（230003/230004 等）→ 回退为 create 新消息；thread 内不回退到主话题（防新建话题，hermes 设计）
     - 其他错误 → outbox 重试
```

### 3.6 outbound/outbox.ts

- 复刻 pi-feishu-link：`RetryableError`/`FatalDeliveryError` 分类；失败消息入 outbox 持久化（`feishu-bridge/outbox.jsonl`），指数退避重投（10s→300s，最多 5 次），Fatal 直接丢弃并告警。

### 3.7 commands/（TUI 与飞书斜杠命令）

| 命令 | 作用 |
|---|---|
| `/feishu status` | 连接状态、会话数、最近消息、outbox 深度、水合 bot 身份 |
| `/feishu start` / `stop` / `restart` | 桥生命周期（daemon 模式控制子进程） |
| `/feishu setup` | 交互式配置（appId/secret/策略） |
| `/feishu policy <chatId> <open\|mention\|disabled>` | 运行时改单群策略（落盘 config.json） |
| `/feishu debug` | 打开 debug 日志 |

## 4. 群策略与准入（admit）

按优先级：

1. `admins`（open_id 集合）→ 永远放行（群内）。
2. DM（p2p）→ `allowUsers` 白名单（空 = 全部放行，等待配对审批）。
3. 群消息：
   - `groupPolicyByChat[chatId]`（每群覆盖）→ 否则全局 `groupPolicy`
   - `open`：放行（mention 仍建议但可配 `requireMention:false`）
   - `mention`：必须 mention bot（判定见下）或回复 bot 的消息（`replyToMessageId` 命中本 bot 最近 64 条已发消息缓存）→ 放行
   - `disabled`：拒绝
   - `allowlist`：`allowChats[chatId]` 命中才放行（与 mention 策略叠加：白名单群按策略，非白名单群拒收）
4. **mention 判定**（hermes 设计，B2 根治）：
   - `@_all`（@所有人）→ 视为提及
   - `mention.id.open_id === botOpenId` 或 `mention.id.user_id === botUserId`（ID 优先，双方都有 ID 时不等即跳过，不做 name 兜底）
   - 任一侧缺 ID → name 兜底（`mention.name === botName`）
5. 转发消息：mention 元数据缺失时按 `groupPolicyByChat` 判定（默认 mention 拒收，管理员可对该群开 `open` 接收转发）。

## 5. 配置（env 优先，config.json 持久化）

```jsonc
// feishu-bridge/config.json（模式 D 下同 pi-feishu-link 的存储位置）
{
  "appId": "cli_xxx",                // env: FEISHU_APP_ID
  "appSecret": "xxx",                // env: FEISHU_APP_SECRET
  "domain": "feishu",                // feishu | lark
  "botOpenId": "",                   // 可选；启动后由 /bot/v3/info 水合覆盖
  "groupPolicy": "mention",          // 全局默认 open|mention|disabled
  "groupPolicyByChat": { "oc_xxx": "open" },
  "allowChats": [],                  // 群白名单（空 = 全部群按策略）
  "allowUsers": [],                  // DM 白名单（空 = 全部放行）
  "admins": [],
  "groupAlsoOnReply": true,          // mention 群中回复 bot 消息免 @
  "requireMention": true,
  "batch": { "textWindowMs": 3000, "enabled": true },
  "forwarding": { "acceptMergeForward": true },
  "approval": { "autoApprove": [], "timeoutMs": 300000 },
  "reaction": { "processingEmoji": "THINKING", "enabled": true },
  "sessionDir": "sessions/feishu",
  "debug": false
}
```

## 6. 数据流时序

### 6.1 入站（群内用户 @bot 回复 bot 上一条消息）

```
WS receive_v1 → transport 归一化 → pipeline
  → dedup(message_id 未见过)
  → admit(群 policy=mention, @_all/@mention 命中 → 放行)
  → reply-resolve(parent_id=上一条, GET 消息原文 → reply_to_text)
  → ConversationManager[chat].enqueue
  → BridgeSession.prompt("[回复 用户 原文…]: 新内容")
  → agent 流式 → outbound(sender) 逐片 send(chat, text, replyTo=bot 上一条 id)
  → reply API(uuid 幂等) → 飞书客户端显示真实回复链 ✓
```

### 6.2 出站失败回退

```
reply API 返回 code=230003(消息不存在) → sender 降级 create 新消息到 chat
    （thread 场景：create 到 thread_id，避免新建话题）
```

## 7. 兼容性契约

### 7.1 运行环境

- pi ≥ 0.84.4（容器内），Node ≥ 20，TypeScript 直接运行（容器内 npm/node_modules 装包后由 entrypoint 启动，与 pi-feishu-link 同机制，无编译步骤）。

### 7.2 官方 pi API 契约表（只允许使用这些导出，全部已用 index.d.ts grep 验证于 0.84.4）

| API | 用途 |
|---|---|
| `createAgentSession` / `SessionManager.open` | per-chat 会话（pi-feishu-link 已验证可用） |
| `ExtensionAPI` | 扩展入口、`pi.on`/`pi.registerCommand`/`ui.setStatus` |
| `TurnEndEvent` / `AgentEndEvent` | 流式事件 |
| `getAgentDir` / `getPackageDir` | 路径解析 |

**红线**：不调用 `AuthStorage.create`、`ModelRegistry.create`、任何 `pi-coding-agent` 非导出符号（pi-feishu-lark 迁移失败的教训）。

### 7.3 与 pi-feishu-link 的共存与切换

- 独立包名 `pi-feishu-bridge`、独立配置目录 `feishu-bridge/`（旧桥 `feishu-link/`）、独立会话目录 `sessions/feishu/`。
- 切换：settings.json packages 替换 `npm:pi-feishu-link` → 新桥；旧桥代码保留在 node_modules 可回滚；config.json 从 `feishu-link/config.json` 迁移（字段兼容映射表见 docs/MIGRATION.md）。

## 8. 测试策略

- 单元：pipeline（normalize/dedup/batch/admit/reply-resolve）纯函数测试；mention 判定表驱动（含 @_all、ID 缺省、name 兜底、转发场景）。
- 集成（fake SDK）：transport 事件→pipeline→dispatch 全链路；sender 回退分支。
- 手工验证矩阵（部署后）：私聊/群 @/群回复/转发合并消息/图片/长文 chunk/消息撤回后回复（回退分支）。

## 9. 里程碑

| M | 内容 | 验收 |
|---|---|---|
| M1 | 仓库骨架 + 设计文档 + 类型检查 | `tsc --noEmit` 通过 |
| M2 | transport + pipeline + admit + reply-resolve 全链路（fake SDK 测试） | 单元测试绿 |
| M3 | session backend + sender + outbox | 集成测试绿 |
| M4 | 容器部署切换 + 飞书实测 | 三类 bug 场景全部修复验证 |

## 10. 待决问题（开放）

- [ ] 流式输出：首版同步 chunk 发送（pi-feishu-link 现状）；后续评估卡片流式（hermes 无，pi-feishu-link 有 reasoning card）。
- [ ] 审批卡片：复用 pi-feishu-link 的 permission-bridge 设计或首版直通（autoApprove）。
- [ ] reaction 处理中 emoji：默认开启但可关（飞书 API 限流需守护）。

## 11. 实现踩坑记录（2026-09-02 部署实测）

| 坑 | 现象 | 修复 |
|---|---|---|
| lark SDK 1.73.1 `EventDispatcher` 不接受 undefined 参数 | `Cannot destructure property 'encryptKey' of 'params'` | `new EventDispatcher({})` |
| SDK 1.73.1 WSClient **没有 `stop()`**，关闭方法是 `close({force})` | stop() 静默失败 → WS 连接泄漏 → 飞书「连接数超限」code=1000040350 | 接口改 `close({force:true})`；start() 前先关旧实例 |
| watchdog 握手期误判 | 每次启动多一次多余重连（水合 → reconnect → ready） | `connectStartedAt` + 15s 宽限期 |
| bot 身份水合字段 | `/open-apis/bot/v3/info` 返回 `app_name`（非 bot_name） | name 兼容 app_name |
| 会话文件相对路径 | `sessions/feishu/…` 相对 cwd=/workspace → EACCES | ConversationManager 注入绝对 sessionDir |
