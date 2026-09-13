# Pi 飞书桥 V2 验收记录

> 日期：2026-09-06
>
> 范围：本地代码、自动化测试、静态检查与 V2 首次真实启动
>
> 结论：P0/P1 本地验收通过，生产插件已切换 V2 且真实 WS 初始连接稳定；消息矩阵、故障注入、24 小时观察及回滚演练尚未完成，因此 V2 尚未达到整体完成定义。

## 1. 本地验收结果

在 `pi-feishu-bridge/` 执行：

```bash
npm run typecheck
npm test
git diff --check
git -C .. diff --check
bash -n ../docker/prepare-env.sh ../docker/status.sh
docker run --rm --entrypoint sh -v "$PWD:/workspace/pi-feishu-bridge" -w /workspace/pi-feishu-bridge dm-pi-agent:0.1 -lc 'pi --version && npm run typecheck && npm test'
```

结果：

- TypeScript 类型检查通过。
- 自动发现 21 个测试文件，共 161/161 通过，宿主约 4.2 秒、容器约 4.3 秒退出。
- 当前仓库与父仓库 diff whitespace 检查均通过。
- 真实子进程覆盖发送前/服务端接收后 `SIGKILL`，重启后复用稳定 UUID；两个真实 PID 竞争 app lock 时第二个 fail-fast。
- `pangu-pi-base:0.1`、`dm-pi-agent:0.1` 已重建，镜像内 `pi --version` 为 0.84.4。
- `.env`、旧桥/新桥 config.json 现场权限已从 0644 收紧为 0600；准备脚本会保留 LARK/GIT/proxy 值并以 0600 写入。
- 真实飞书只读预检 `GET /open-apis/bot/v3/info` 返回 code 0，open_id 与名称均成功水合。
- 2026-09-06 将 `pi-agent/settings.json` 从 `npm:pi-feishu-link` 切换为 `./pi-feishu-bridge` 并重启容器；旧 gateway 锁被清理，当前仅有 V2 app lock。
- 首次启动暴露 SDK `getConnectionStatus()` 返回对象而非字符串的兼容问题；修复并新增回归测试后，连续 5 次采样均为 `connected`、`reconnectCount=0`，当前启动周期日志无重连错误。
- 2026-09-07 在尚无会话的群聊中真实发送 `@飞书 CLI /model`：V2 创建 Pi session，回复 `当前模型：deepseek-v4-flash` 并挂载原消息；状态为 `messageTotal=1`、`conversations=1`，outbox 一次投递成功且无失败，旧版“当前会话尚未建立”问题已闭环。

## 2. 需求—证据矩阵

| 阶段 | 实现证据 | 自动化证据 | 结论 |
|---|---|---|---|
| P0-0 测试基线 | `package.json` 自动发现测试 | 全量回归、类型检查、快速退出 | 通过 |
| P0-1 入站与合并 | `src/inbound/pipeline.ts`、`src/session/conversation-key.ts` | `pipeline.test.ts` | 通过 |
| P0-2 mention 与策略 | `src/inbound/normalize.ts`、`src/inbound/admit.ts`、`src/config.ts` | `normalize.test.ts`、`admit.test.ts`、`config.test.ts` | 通过 |
| P0-3 session 生命周期 | `src/session/conversation-manager.ts`、`src/session/pi-session-backend.ts` | shutdown 续跑/挂起调用、订阅、超时、首次 `/model` 懒初始化测试 | 通过 |
| P0-4 durable final | `src/outbound/outbox.ts`、`src/outbound/sender.ts` | sender/outbox、真实子进程 SIGKILL 测试 | 通过（本地故障服务器） |
| P0-5 恢复与单实例 | `src/inbound/dedupe-store.ts`、`src/session/pending-store.ts`、`src/runtime/` | 两 PID 锁、重连竞态、补收截断测试 | 通过 |
| P1-1 媒体 | `src/inbound/resource-resolver.ts`、`src/outbound/artifact.ts`、`src/outbound/local-file-tool.ts` | MIME/大小/TOCTOU/spool/降级测试 | 通过（Fake SDK） |
| P1-2 流式 | `src/outbound/agent-event-adapter.ts`、`src/outbound/live-channel.ts` | turn_end/live-final 并发/熔断测试 | 通过（Fake SDK） |
| P1-3 审批 | `src/approval/permission-bridge.ts`、`src/approval/cards.ts` | 越权/旧卡/挂起发送/脱敏/transport action 测试 | 通过（组件级） |
| P1-4 命令与诊断 | `src/index.ts`、`src/slash-commands.ts`、`src/runtime/doctor.ts`、`src/runtime/status-store.ts` | steer/queue/stop/help、pipeline/doctor/conversation/config 测试 | 通过（组件级） |

## 3. 尚未验证的外部验收

真实 WS 与基础启动已通过，以下项目仍需在已配置群内触发真实消息后执行，会发送/编辑消息并可能触发工具审批：

1. `DESIGN-V2.md` §9.3 的真实飞书灰度矩阵（首次 `/model` 懒初始化已通过，其余场景待测）。
2. 真实飞书链路上的发送中 kill、WS 断线、Pi turn 超时、容器 restart 四类故障注入；本地子进程 kill 已通过，不替代服务端验收。
3. 连续 24 小时观察：静默丢消息、重复 final、残留 reaction、WS/句柄泄漏。
4. 停旧桥、启新桥已完成；逐群功能验证、切回旧桥及人工对账演练尚未执行。

## 4. 灰度执行清单

- [x] 复用现有 app、3 群 allowChats、1 名管理员与 mention 策略启动 V2。
- [x] 确认旧桥该 app 的 WS 已停止，避免双消费者。
- [ ] 仅向测试群开放，运行 `/feishu doctor` 与 `/feishu status` 留证。
- [ ] 逐项执行 §9.3 矩阵并记录 message_id、runId、envelopeId 和结果；不得记录密钥或完整敏感正文。
- [ ] 执行四类故障注入并核对 `status.json`、日志和聊天可见结果。
- [ ] 观察满 24 小时后决定是否进入生产切换；任一门槛失败即保持旧桥。
- [ ] 切换后立即演练一次回滚并人工对账切换窗口消息。
