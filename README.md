# pi-feishu-bridge

飞书/Lark ↔ Pi Agent 桥。V2 已完成 P0/P1 本地实现与自动化验收；真实飞书灰度、24 小时观察和生产切换尚未执行。完整范围与当前证据见 `docs/DESIGN-V2.md`、`docs/ACCEPTANCE-V2.md`。

| 缺陷 | pi-feishu-link | 本桥 |
|---|---|---|
| B1 回复消息拿不到 | `lastMessageId === parentId` 内存猜测 + 不拉原文 | 解析 `parent_id/upper_message_id/root_id` → 接受并**拉取被回复原文**；出站挂真实 reply API + uuid 幂等 + 撤回回退 |
| B2 @mention 判定脆 | 只认 mention.open_id == botOpenId | ID 优先 + name 兜底 + `@_all`；启动自动水合 bot 身份（/open-apis/bot/v3/info） |
| B3 会话链路错误 | 单链 route，无 thread | 每 chat 独立 `createAgentSession`（隔离队列）；thread_id 透传；话题内回复不回退到主话题 |

设计文档：`docs/DESIGN-V2.md`（当前实施基线）；`docs/DESIGN.md` 为 V1 历史方案。参考实现位于 `feishu-refs/`。

## 安装（本地路径）

```bash
# settings.json packages 增加（相对 settings 文件解析）
"packages": ["./pi-feishu-bridge", ...]

# 或 pi 命令
pi install /path/to/pi-feishu-bridge
```

依赖：`@larksuiteoapi/node-sdk`（同 pi-feishu-link）。peer：`@earendil-works/pi-coding-agent`（运行时由 pi 提供）。

## 配置

env 优先，config.json 持久化（`$HOME/feishu-bridge/config.json`，`FEISHU_BRIDGE_HOME` 可覆盖 home）：

最小灰度模板见 `config.example.json`。复制后必须把文件权限设为 0600，并将 `allowChats` 限定为测试群。

| env | config.json | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | appId / appSecret | 必填 |
| `FEISHU_DOMAIN` | domain | feishu \| lark |
| `FEISHU_GROUP_POLICY` | groupPolicy | open \| mention \| disabled \| allowlist \| blacklist \| admin_only |
| `FEISHU_GROUP_POLICY_BY_CHAT` | groupPolicyByChat | JSON：{chatId: policy} 每群覆盖 |
| `FEISHU_GROUP_RULES` | groupRules | JSON：每群 policy/allowlist/blacklist/requireMention |
| `FEISHU_ALLOW_CHATS` / `FEISHU_ALLOW_USERS` / `FEISHU_ADMINS` | 同名字段 | csv |
| `FEISHU_GROUP_ALSO_ON_REPLY` | groupAlsoOnReply | 回复 bot 消息免 @ |
| `FEISHU_REQUIRE_MENTION` | requireMention | allowlist 群内是否仍需 @ |
| `FEISHU_DEBUG` | debug | debug 日志 |
| `FEISHU_STREAMING_CARD` | streamingCard.enabled | 流式卡片（CardKit）；explicit `0` 可强制关闭 |
| — | adminBypassMention | 管理员/应用归属人是否毙免 @（**默认 false**：群内也需 @） |
| — | streamingCard.throttleMs | 卡片更新节流（毫秒，默认 800） |

## 命令

飞书消息内命令（显式路由，不进入 Agent）：

- `/feishu status`、`/feishu doctor`
- `/feishu policy <open|mention|disabled|allowlist|blacklist|admin_only>`（仅管理员，修改当前群）
- `/help`（别名 `/commands`、`/feishu help`）— 列出全部飞书端命令和用法
- `/new`、`/stop`、`/compact [指令]`、`/model [模型 ID]`（首次调用会初始化会话，可直接查看或切换模型）
- `/steer <内容>` — 注入当前任务；空闲时直接开始
- `/queue <内容>`（别名 `/q`）— 当前任务完整结束后执行独立的新 turn

同一会话忙碌时，直接发送普通消息默认按 Pi `steer` 语义在当前 assistant turn/工具批次结束后注入；需要明确等待整个任务结束时使用 `/queue`。`/stop` 只中止当前任务，已通过 `/queue` 排队的后续任务继续执行。

Pi 终端命令：

- `/feishu:status` — 连接/bot 身份/会话/outbox/策略
- `/feishu:start` `/feishu:stop` `/feishu:restart`
- `/feishu:policy <chatId> <open|mention|disabled|allowlist|blacklist|admin_only>` — 运行时改单群策略并原子落盘
- `/feishu:debug on|off`

Agent 可通过 `feishu_send_local_file` 显式回传工作区内的图片、MP4、Opus/Ogg 或普通文件；最终文本和媒体均由持久 outbox 投递。危险工具调用通过飞书审批卡片执行一次/session/always/deny 决策。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 自动发现 tests/**/*.test.ts（当前 317 个用例）
```

## 部署（容器 dm-pi-agent）

1. docker-compose 挂载 `./pi-feishu-bridge` 到 `/workspace/pi-agent/pi-feishu-bridge`（含 node_modules）
2. 仅在 `docs/DESIGN-V2.md` 灰度门槛全部通过后，才从 `pi-agent/settings.json` 移除 `npm:pi-feishu-link` 并加入 `./pi-feishu-bridge`
3. compose env 注入 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
4. 旧桥配置不会自动迁移；切换前人工映射 appId/appSecret、群策略、allowChats、allowUsers、admins，并确保仅开放测试群
5. 执行 `docker compose restart`，核对旧 WS 已关闭、新桥 app lock/WS/doctor 正常后再逐群开放
6. 回滚：停止新桥、保留其 session/outbox，再恢复 settings.json packages 并重启；旧桥 node_modules 保留
