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
- **「始终批准」跨进程可用**：`pi-permission-system` 转来的 ask 同样支持「始终批准」—— 语义对齐 PS 原生对话框（记在**父会话**而非子会话，撤销后立即恢复询问），入口是 `/feishu always`
- **澄清选择卡**：Agent 可就地提问并给出选项，超时或越权自动回退为文本
- **流式输出**：内置文本流式（默认）；可选 CardKit 流式卡片（需应用权限，见下）
- **进度与思考**：工具名 + 耗时 + 脱敏命令摘要，工具风暴自动折叠
- **页脚指标**（卡片里是**独立一块**：分割线 + 小号淡色）：
  ```
  本轮 deepseek-flash · 1.8s · in 251 / out 21 · cache 20.5k · <$0.01 / <¥0.01（估算）
  会话 in 67.4k / out 9.4k · cache 514.7k · ctx 2.1%（20.8k/1.0M） · $0.02 / ¥0.13（估算）
  ```
  - **本轮**＝这一轮花的（跨工具多轮累加）；**会话**＝本次聊天累计 + 当前上下文占用
  - 费用 2 位小数；不足一分钱显示 `<$0.01`（不显示假 0）；¥ 由**官方 CNY 价表**推导（不是汇率），模型不在价表内时只显示 `$`
  - 开关：`footer.showCost` / `showCny` / `showContext` / `showSession`（`showSession:false` 只留本轮）
  - **群级开关**：`/feishu footer off`（管理员/应用归属人）关掉当前会话的页脚，`/feishu footer on` 恢复，`/feishu footer` 查看状态；
    落盘在 `config.json` 的 `footerByChat`（缺省跟随全局 `footer.enabled`，默认开）。页脚只进**出站消息**，不进会话历史/上下文

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
| `/feishu usage` | 本会话累计用量（输入=未命中+缓存命中、命中率、上下文占用、费用）+ DeepSeek 账户余额、消耗速率与预计可用时长 |
| `/feishu footer [on\|off]` | 管理员开关**当前会话**的页脚（默认开，落盘 `footerByChat`，活过重启） |
| `/feishu always [revoke <规则名>]` | 管理员查看/撤销「始终批准」规则（转发路径的持久放行） |

### 触发与准入

- 群策略：`open` / `mention` / `disabled` / `allowlist` / `blacklist` / `admin_only`，支持每群覆盖
- 管理员语义分两层：**策略层**豁免（`admin_only` 等），**@ 层**默认不豁免（`adminBypassMention`）
- 应用**归属人自动水合**为隐式管理员（换应用后重启自动刷新，不写配置文件）
- `allowBots` 白名单：允许自定义机器人 / webhook 驱动
- `ignoreAtAll`：默认过滤 `@所有人`

---

## 快速开始

### 1) 用 pi 从 git 安装（推荐）

```bash
# 装到用户级设置（~/.pi/agent/settings.json）
pi install git:github.com/chenydev/pi-feishu-bridge

# 生产建议钉到具体 commit（仓库当前不打 tag；若以后有 tag，可直接写 @v0.1.0）
pi install git:github.com/chenydev/pi-feishu-bridge@<commit-sha>

# 用 SSH（走本机 ~/.ssh/config 里的密钥）
pi install git:git@github.com:chenydev/pi-feishu-bridge

# 装到项目级设置（.pi/settings.json，可随仓库共享）
pi install -l git:github.com/chenydev/pi-feishu-bridge
```

- pi 会把仓库 clone 到 `~/.pi/agent/git/github.com/chenydev/pi-feishu-bridge`（项目级为
  `.pi/git/...`），并自动在 clone 里执行 `npm install`。
  - `@larksuiteoapi/node-sdk`（飞书 SDK）是运行依赖；
  - `@earendil-works/pi-coding-agent` 声明为 peer，但 **npm 7+ 会自动把 peer 一起装进 clone**
    （实测 `pi install` 后 clone 的 `node_modules` 里有它）—— 桥在建子会话时会动态
    `import` 它（`src/session/pi-session-backend.ts`），所以这份拷贝不是多余的。
- 仓库里的 `package.json` 声明了 `pi.extensions: ["./src/index.ts"]`，安装后 pi 启动时
  自动加载桥的扩展（WS 长连接 daemon、`/feishu` 命令、审批卡、工具进度都在这条扩展里）。
- 只想跑一次、不写设置：`pi -e git:github.com/chenydev/pi-feishu-bridge`。
- 看装了什么：`pi list`；卸载：`pi remove git:github.com/chenydev/pi-feishu-bridge`。

### 2) 更新

git 源是**按 ref 钉住**的：`pi update --extensions` / `pi update --all` 不会把它挪到更新的
ref，只会把已有的 clone 对齐到设置里写的 ref。要升级就显式指到新 ref：

```bash
pi install git:github.com/chenydev/pi-feishu-bridge@<new-tag-or-commit>
```

### 3) 准备配置

```bash
mkdir -p ~/.pi/agent/feishu-bridge
cp <clone-or-repo>/config.example.json ~/.pi/agent/feishu-bridge/config.json
chmod 600 ~/.pi/agent/feishu-bridge/config.json
# 填入 appId / appSecret，并把 allowChats 限定为测试群
```

配置目录默认取 pi 的 agent 目录（`pi.getAgentDir()`，通常 `~/.pi/agent`）；
可用 `FEISHU_BRIDGE_HOME` 改写（容器里就是显式设成 pi 的配置目录）。

### 4) 启动

```bash
pi --mode rpc --provider <provider> --model <model>
```

桥随 pi 进程启动；装了 `pi-permission-system` 时还需配 `ask` 规则才会弹飞书审批卡
（见下面「让 pi-permission-system 的 `ask` 走飞书审批卡」）。

依赖：`@larksuiteoapi/node-sdk`
peer：`@earendil-works/pi-coding-agent`（`pi install` 的 `npm install` 会一并装进 clone；桥用它创建子会话）

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

env 优先，`config.json` 持久化（路径 `$FEISHU_BRIDGE_HOME/feishu-bridge/config.json`；
`FEISHU_BRIDGE_HOME` 未设时取 pi 的 agent 目录，即默认 `~/.pi/agent/feishu-bridge/config.json`）。

完整模板见 `config.example.json`。常用项：

| env | config.json | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `appId` / `appSecret` | 必填 |
| `FEISHU_DOMAIN` | `domain` | `feishu` \| `lark` |
| `FEISHU_GROUP_POLICY` | `groupPolicy` | 群策略默认值 |
| `FEISHU_ALLOW_CHATS` / `FEISHU_ALLOW_USERS` / `FEISHU_ADMINS` | 同名字段 | csv |
| `FEISHU_STREAMING_CARD` | `streamingCard.enabled` | `1` 打开流式卡片（默认关） |
| `FEISHU_PS_FORWARDING` | `approval.forwarding.enabled` | `1` 打开「pi-permission-system 父会话转发」（默认关，见下） |
| `FEISHU_TIMEZONE` | `timezone` | 展示用时区（IANA 名，默认 `Asia/Shanghai`）。判定顺序：`FEISHU_TIMEZONE` > 配置文件 > 容器 `TZ` > 默认。无效值自动跳过，不会导致启动失败 |
| — | `approval.forwarding.parentSessionId` | 桥侧父会话 id（默认 `feishu-bridge-parent`） |
| `FEISHU_PS_ALWAYS` | `approval.forwarding.alwaysApprove` | 转发路径的「始终批准」（默认 **开**）：命中已记规则的 ask 直接放行、不再弹卡。`0` 关闭（关掉后卡片只剩三档） |
| — | `streamingCard.printFrequencyMs` / `printStep` | 打字机节奏：每 N 毫秒上屏 M 字。**平台默认 1字/70ms（500 字要播 35 秒）**，推荐 3字/20ms（150 字/秒） |
| — | `approval.adminSkipApproval` | 管理员/归属人免审批（默认 `false`） |
| — | `adminBypassMention` | 管理员是否豁免 @（默认 `false`） |
| — | `runIdleTimeoutMs` | 空闲超时（默认 10 分钟）；`runMaxDurationMs` 默认 `0` 不限制总时长 |
| — | `workspaces.aliases` | 工作区别名白名单（默认空 = 功能关闭） |

环境变量优先级**高于** `config.json` —— 注意 shell 里残留的同名变量会静默覆盖配置文件。

**时区**：容器基础镜像是 UTC，compose 里用 `TZ=${DMA_TZ:-Asia/Shanghai}` 设成上海（改这个需要 `docker compose up -d` 重建，`restart` 不生效）。
⚠️ **`docker logs --timestamps` 的时间戳永远是 UTC** —— 那是 Docker 守护进程加的，容器 `TZ` 影响不了它；容器内的 `date` 和应用内的时间显示才跟随 `TZ`。排障时对齐时间记得差 8 小时。

### 让 pi-permission-system 的 `ask` 走飞书审批卡（实验性，默认关）

`approval.policyEngine = "pi-permission-system"` 时策略归该扩展，但它的 `ask` 需要一个**父会话**来应答：
子会话把请求写进文件信箱，父会话写回响应。桥可以扮演这个父会话（而且不要求是 pi 进程）：

```jsonc
// config.json
"approval": { "forwarding": { "enabled": true } }   // 或 FEISHU_PS_FORWARDING=1
```

- 桥向进程环境声明父子关系：`PI_SUBAGENT_PARENT_SESSION`（PS 文档的 subagent adapter convention，主变量）
  与 `PI_AGENT_ROUTER_PARENT_SESSION_ID`（历史兼容名，同值）—— 两者都指向桥侧父会话 id，
  因此进程内所有会话的 ask 都会转发给桥；然后在 `$PI_CODING_AGENT_DIR/sessions/permission-forwarding/`
  下发布心跳、轮询子会话的请求文件，把每个 `ask` 变成飞书审批卡；用户点完写回响应。
- 卡片只提供**「仅本次 / 本会话 / 拒绝」** —— 转发路径写不进对方策略引擎的配置，所以不给「始终批准」这种做不到的按钮。
- 打不开时的降级行为：扩展缺席则不声明父子关系（回落到现状）；关掉开关会撤掉自己的声明。
- 轮询/心跳参数（`PS_FORWARDING_POLL_INTERVAL_MS` 等）对齐 33.0.3 的实现，见 `src/approval/ps-forwarding.ts`。

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

- **打字机速度必须显式配置**：平台默认是「每次 1 字、间隔 70ms」，500 字要播 35 秒 —— 现象是「服务端早已推完、桌面端还在慢慢吐」。必须传 `streaming_config.print_step` / `print_frequency_ms`（本桥默认 3字/20ms）。
- **卡片写入不能并发**：并发会让 `sequence` 乱序，飞书侧最终渲染为空白卡片。写入保持严格串行。
- **`streaming_mode` 不可置 `false`**：置 `false` 后 `/content` 接口不可用（卡片会停在初始文案）。注意它只影响该接口 —— 整组件替换（`PUT /cards/{id}/elements/{eid}`）仍然可用。
- **`partial_strategy` 字段不存在**：`/content` 的请求契约只有 `uuid` / `content` / `sequence`。

---

## 许可

MIT
