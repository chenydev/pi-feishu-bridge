# pi-feishu-bridge

**飞书 / Lark ↔ Pi Agent 桥。** 把 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码助手接进飞书群聊与私聊，带消息可靠性保证、交互式审批、会话管理与可观测性。

> 定位：**面向生产使用的桥**，把「消息不丢、执行不串、出站必达」放在第一位，体验能力（流式、卡片、命令）作为其上增量。

---

## 特性

### 可靠性（核心）

| 能力 | 说明 |
|---|---|
| **入站不丢** | 消息在去重判定与派发**之前**先落持久化接管账本；崩溃重启后按账本重放，消除 dedupe/batch/ledger 之间的丢失窗口 |
| **出站必达** | Durable outbox 双通道（实时 + 落盘重投），按 `messageId` 幂等，失败自动重试 |
| **写入有序** | 同一消息的实时更新与终态写入严格串行，终态必为该消息**最后一次**写入，不会被迟到的进度覆盖 |
| **无损分片** | 长回答按 grapheme 边界切分，代码围栏跨片补齐、emoji 代理对不会被拆开 |
| **会话隔离** | 每会话独立 agent 与队列，`conversationKey → sessionFile` 持久化指针，重启不丢上下文 |

### 交互

- **工具审批卡**：工具调用前弹卡片（一次性 / 本会话 / 始终 / 拒绝），超时自动失效，防重放；管理员可配置免审批
- **澄清选择卡**：Agent 可就地提问并给出选项，超时或越权自动回退为文本
- **流式输出**：内置文本流式（默认）；可选 CardKit 流式卡片（需应用权限，见下）
- **进度与思考**：工具名 + 耗时 + 脱敏命令摘要，工具风暴自动折叠
- **页脚指标**：模型 · 耗时 · in/out tokens · cache · 费用（估算）

### 命令

| 命令 | 作用 |
|---|---|
| `/new` `/new force` | 开新会话（有排队任务时默认拒绝，`force` 显式取消） |
| `/stop` | 中止当前任务 |
| `/queue` | 查看排队任务 |
| `/sessions` `/name` `/resume` | 浏览、重命名、恢复历史会话 |
| `/model` `/models` `/thinking` | 切换模型与思考强度 |
| `/workspace` | 切换工作区（白名单别名） |
| `/feishu status` `/feishu policy` `/feishu export` | 状态、群策略、脱敏诊断包导出 |

### 触发与准入

- 群策略：`open` / `mention` / `disabled` / `allowlist` / `blacklist` / `admin_only`，支持每群覆盖
- 管理员语义分两层：**策略层**豁免（`admin_only` 等），**@ 层**默认不豁免（`adminBypassMention`）
- 应用**归属人自动水合**为隐式管理员（换应用后重启自动刷新，不写配置文件）
- `allowBots` 白名单：允许自定义机器人 / webhook 驱动
- `ignoreAtAll`：默认过滤 `@所有人`

---

## 快速开始

```bash
npm install

# 1) 准备配置
cp config.example.json ~/feishu-bridge/config.json
chmod 600 ~/feishu-bridge/config.json
# 填入 appId / appSecret，并把 allowChats 限定为测试群

# 2) 注册到 pi
pi install /path/to/pi-feishu-bridge

# 3) 启动
pi --mode rpc --provider <provider> --model <model>
```

依赖：`@larksuiteoapi/node-sdk`
peer：`@earendil-works/pi-coding-agent`（运行时由 pi 提供）

### 飞书应用所需权限

| 权限 | 用途 |
|---|---|
| `im:message` `im:message:send_as_bot` | 收发消息 |
| `im:message.reaction:write` | 处理中表情 |
| `im:chat:readonly` | 群信息 |
| `cardkit:card:write` | **可选**：CardKit 流式卡片（未授权时自动降级为文本） |

订阅事件：`im.message.receive_v1`；卡片交互需订阅 `card.action.trigger`。

---

## 配置

env 优先，`config.json` 持久化（路径 `$FEISHU_BRIDGE_HOME/feishu-bridge/config.json`，默认取 `$HOME`）。

完整模板见 `config.example.json`。常用项：

| env | config.json | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `appId` / `appSecret` | 必填 |
| `FEISHU_DOMAIN` | `domain` | `feishu` \| `lark` |
| `FEISHU_GROUP_POLICY` | `groupPolicy` | 群策略默认值 |
| `FEISHU_ALLOW_CHATS` / `FEISHU_ALLOW_USERS` / `FEISHU_ADMINS` | 同名字段 | csv |
| `FEISHU_STREAMING_CARD` | `streamingCard.enabled` | `1` 打开流式卡片（默认关） |
| — | `approval.adminSkipApproval` | 管理员/归属人免审批（默认 `false`） |
| — | `adminBypassMention` | 管理员是否豁免 @（默认 `false`） |
| — | `runIdleTimeoutMs` | 空闲超时（默认 10 分钟）；`runMaxDurationMs` 默认 `0` 不限制总时长 |
| — | `workspaces.aliases` | 工作区别名白名单（默认空 = 功能关闭） |

环境变量优先级**高于** `config.json` —— 注意 shell 里残留的同名变量会静默覆盖配置文件。

---

## 架构

```
飞书 WS 事件 ──▶ 准入（策略/白名单/去重）
                   │
                   ▼
              接管账本（先持久化，再派发）      ← 崩溃可重放
                   │
                   ▼
              会话路由（conversationKey → 独立 agent + 队列）
                   │
                   ▼
              Pi Agent（工具调用经审批门控）
                   │
                   ▼
              出站通道（串行写入 + durable outbox）──▶ 飞书
```

关键不变式（均有测试覆盖）：

1. 消息进入内存批次之前必先落账本
2. 同一消息的写入严格串行，终态最后落地
3. 审批状态与 run 生命周期一致，run 结束即失效
4. 卡片链路故障**不阻塞**最终交付（自动降级为文本）

---

## 测试

```bash
npm test          # 320 个用例
npm run typecheck
```

覆盖：入站持久化与重放、出站顺序与幂等、分片边界、会话指针、审批生命周期、限速预算、调度公平性、卡片降级路径，以及端到端可靠性矩阵。

---

## 参考与致谢

本项目在设计过程中参考了以下公开实现与思路：

| 项目 | 参考点 |
|---|---|
| [**pi-feishu-link**](https://www.npmjs.com/package/pi-feishu-link) | **最初的桥接基础**（本桥的前身）。沿用了 `@larksuiteoapi/node-sdk` 的 WS 长连方式、`message_update` 事件通道累积回复文本的做法，以及「处理中表情 → 撤回」的交互惯例 |
| [**pi-feishu**](https://www.npmjs.com/package/pi-feishu) | 飞书侧消息召回/去重的处理思路 |
| [**ax-feishu-bridge**](https://www.npmjs.com/package/ax-feishu-bridge) | 会话管理与会话浏览类命令的产品形态 |
| [**@tunglam/pi-lark-cli**](https://www.npmjs.com/package/@tunglam/pi-lark-cli) | 飞书技能的集成方式（技能包与 CLI 版本配对） |

另有若干**内部产品**在交互模型上给了重要启发（@ 触发的两层模型、回复引用的注入格式、工具审批的卡片形态），因其非公开，此处不列名。

**本项目的差异化**：上述实现多把重心放在「连接与体验」，本桥把重心放在**消息可靠性**（入站账本、出站必达、写入有序、审批生命周期）与**可验收性**（每条不变式都有对应测试与真实环境验收记录）。

依赖与许可：飞书 SDK 为 MIT；本项目沿用其上游许可约束。

---

## 已知问题

- **CardKit 流式卡片在桌面客户端有逐字动画**：同一个 `streaming_mode` 卡片，移动端立即显示全文，桌面端逐字播放。这是客户端渲染行为，服务端无法控制 —— 因此卡片模式默认关闭，默认走文本流式（两端都立即显示）。
- **卡片写入不能并发**：并发会让 `sequence` 乱序，飞书侧最终渲染为空白卡片。写入保持严格串行。
- **`streaming_mode` 不可置 `false`**：该参数是「动态更新能力」开关而非动效开关，置 `false` 后卡片会永远停在初始文案。

---

## 许可

MIT
