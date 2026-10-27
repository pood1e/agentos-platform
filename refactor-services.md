# 计划一：平台服务

[架构收敛重构](refactor.md)的并行计划之一，负责平台服务进程内的状态、身份、读模型、进程形态与语音。设计见[总览](refactor.md#设计)，与[计划二](refactor-kubernetes.md)的分工与同步约定见[并行计划](refactor.md#并行计划)。

## 范围

| 类别 | 内容 |
| --- | --- |
| 服务端 | `server/`，不含 `management`、`governance` 与 `console/{roles,role-template,template-writer}.ts` |
| 前端与 SDK | `src/`，不含 `src/features/{engineers,management}`；其中的语音配置页面归本计划；`shared/` |
| 协议 | `proto/agentos/{console,execution,authorization,voice,mcp,automation,kagent}`，不含 `console/v1/role.proto` |
| 数据 | PostgreSQL schema |
| Chart 与镜像 | 平台工作负载、Service、NetworkPolicy、入口、执行密钥、协作 MCP 注册与语音模板；平台镜像、console 镜像与 `voice/` |

## 单元

### 1.1 执行存储（已实现）

按总览的[执行存储](refactor.md#执行存储)设计实施。

删除：`server/authorization/store.ts` 的整行加密与 `agentos_authorization.objects` 表。

验收：

- 单次工具调用的委派链校验为一次查询（原实现最多 32 次读取与解密）。
- 互换两个主体的密文、使用其他密钥或其他工作空间读取时被拒绝。

### 1.2 身份与前端解耦

按总览的[身份与委派](refactor.md#身份与委派)设计实施。新增 console 镜像、委派端点与密码模式的 identity 入口。

删除：

- `server/authorization/browser.ts`，由委派端点替代；`server/platform/access.ts` 的 Origin 校验与访客主体；`identity.mode: none`。
- 平台 API 镜像中的前端产物与静态托管；`server/mcp-apps/sandbox.ts` 移入 console。
- `charts/agentos/templates/console-ingress.yaml` 与 `sandbox-ingress.yaml`。
- 方案包的 `environments/clients.yaml` 与 `environments/tasks/client-api.yaml`；Controller UI 对平台会话 Cookie 的绑定。

验收：

- 同一平台 API 同时服务 AgentOS console、Controller UI 与 CLI。
- 浏览器退出与 access token 过期后后台任务继续；身份提供方撤销离线会话后，一个 access token 有效期内拒绝后续调用。
- 跨站写请求与 WebSocket 不携带会话；错误的 issuer、audience 与未登记的 `return_to` 被拒绝。
- 密码模式下 console、CLI 与后台任务使用与外部身份提供方相同的授权路径；连续输错密码触发限速。
- console 发版不重启平台 API。

### 1.3 读投影

按总览的[读投影](refactor.md#读投影)设计实施。

删除：`server/read-model` 的 `sync`、`live`、`index`、`checkpoints`、`observation`、`page` 与内存视图，`decode/` 保留为投影写入的解析；`server/jobs/coordination.ts` 的启动全量入队与 checkpoint 订阅；`server/team-sessions/continuation.ts` 的结果截断与语言判断。首次对账从 kagent 回填投影。

验收：

- 就绪时长与进程内存不随任务量增长，与切换前同等任务量对比。
- 平台对 kagent 的请求速率与活动量相关，与历史量无关。
- 运行时写入 1 秒内可见，kagent 侧变化在对账周期内可见。
- 越权读取的负例保持拒绝；测试中的委派关系全部按 ID 解析。

### 1.4 进程拆分

按总览的[进程拆分](refactor.md#进程拆分)设计实施。`server/platform/main.ts` 拆为 `server/apps/{api,dataplane,worker}.ts`；Chart 为各入口分别生成 Deployment、Service 与 NetworkPolicy；网关 extAuth、ExtMCP、协作 MCP 后端与 kagent `controlPlaneUrl` 指向 dataplane；各入口接入 OpenTelemetry Node SDK。验证 agentgateway 远程 JWKS 能否经 BackendTLSPolicy 直连 `ate-idp-server`，可行则删除 9092 中转。

删除：单进程入口、`console-service.yaml` 的多端口 Service、启动路径上的 `automation.seed`（改为 worker 单例作业）。

验收：

- 负载下逐个终止任意 Pod，模型与 MCP 调用无超出网关重试的失败，审批与续接不丢失。
- api 滚动发布不影响 dataplane；console 流式负载下 dataplane 授权 p99 不劣于切换前。
- 各角色 NetworkPolicy 的负例通过。

### 1.5 语音单链路

按总览的[语音](refactor.md#语音)设计实施。

删除：RPC `TranscribeAudio`、`SynthesizeSpeech`、`StartVoiceCall` 与 `EndVoiceCall`；`server/speech` 的 WebSocket 转写代理与合成流；`shared/browser/speech` 与 `shared/browser/voice/chat-bridge.ts`；依赖 `@deepgram/sdk`、`@ricky0123/vad-web`、`@fastify/websocket` 与 `ws`。

验收：

- 听写首个转写片段、朗读首段音频与通话打断的延迟不劣于切换前。
- 页面切到后台或短暂断网后通话继续。
- worker 向未绑定对话发送消息、使用过期语音会话或越过发起人权限的请求被拒绝。

## 顺序

| 单元 | 依赖 |
| --- | --- |
| 1.1 执行存储 | — |
| 1.2 身份与前端解耦 | 1.1 |
| 1.3 读投影 | 1.1 |
| 1.4 进程拆分 | 1.2、1.3 |
| 1.5 语音单链路 | 1.1 |

1.2 与 1.3 互不依赖。1.5 放在 1.4 之后，避免语音接线改两次。
