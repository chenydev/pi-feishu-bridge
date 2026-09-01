# pi-feishu-bridge

飞书/Lark ↔ Pi Agent 桥（hermes 级实现），修复 pi-feishu-link 三大缺陷：

| 缺陷 | pi-feishu-link | 本桥 |
|---|---|---|
| B1 回复消息拿不到 | `lastMessageId === parentId` 内存猜测 + 不拉原文 | 解析 `parent_id/upper_message_id/root_id` → 接受并**拉取被回复原文**；出站挂真实 reply API + uuid 幂等 + 撤回回退 |
| B2 @mention 判定脆 | 只认 mention.open_id == botOpenId | ID 优先 + name 兜底 + `@_all`；启动自动水合 bot 身份（/open-apis/bot/v3/info） |
| B3 会话链路错误 | 单链 route，无 thread | 每 chat 独立 `createAgentSession`（隔离队列）；thread_id 透传；话题内回复不回退到主话题 |

设计文档：`docs/DESIGN.md`（全面设计基线）。参考实现：`feishu-refs/`（8 个 pi feishu 扩展 + hermes-agent 官方 feishu 适配器）。

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

| env | config.json | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | appId / appSecret | 必填 |
| `FEISHU_DOMAIN` | domain | feishu \| lark |
| `FEISHU_GROUP_POLICY` | groupPolicy | open \| mention \| disabled \| allowlist |
| `FEISHU_GROUP_POLICY_BY_CHAT` | groupPolicyByChat | JSON：{chatId: policy} 每群覆盖 |
| `FEISHU_ALLOW_CHATS` / `FEISHU_ALLOW_USERS` / `FEISHU_ADMINS` | 同名字段 | csv |
| `FEISHU_GROUP_ALSO_ON_REPLY` | groupAlsoOnReply | 回复 bot 消息免 @ |
| `FEISHU_REQUIRE_MENTION` | requireMention | allowlist 群内是否仍需 @ |
| `FEISHU_DEBUG` | debug | debug 日志 |

## 命令

- `/feishu:status` — 连接/bot 身份/会话/outbox/策略
- `/feishu:start` `/feishu:stop` `/feishu:restart`
- `/feishu:policy <chatId> <open|mention|disabled|allowlist>` — 运行时改单群策略并落盘
- `/feishu:debug on|off`

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsx --test（52 个用例）
```

## 部署（容器 dm-pi-agent）

1. docker-compose 挂载 `./pi-feishu-bridge` 到 `/workspace/pi-agent/pi-feishu-bridge`（含 node_modules）
2. settings.json `packages` 移除 `npm:pi-feishu-link`，加入 `./pi-feishu-bridge`
3. compose env 注入 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
4. 首次启动自动迁移旧桥配置（feishu-link/config.json → feishu-bridge/config.json）
5. 回滚：恢复 settings.json packages 即可（旧桥 node_modules 保留）
