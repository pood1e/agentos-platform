# 后续架构

当前实现见[架构](docs/architecture.md)，优先级见[实施计划](plan.md)。

## 进程拆分

平台 API、数据面与后台协调分别部署，共用现有 PostgreSQL 和执行授权模型。

| 入口 | 职责 | 就绪条件 |
| --- | --- | --- |
| api | Connect RPC、离线委派、方案包资源、语音会话签发 | 数据库与配置 Informer |
| dataplane | extAuth、ExtMCP、TaskStore / Memory 代理、协作 MCP、Actor JWKS | 数据库与配置 Informer |
| worker | 审批协调、续接、投影对账、预置定时任务 | 数据库 |
| identity | 密码模式身份源 | 数据库 |

`server/apps/{api,dataplane,worker}.ts` 使用同一镜像，Chart 为各入口生成独立的 Deployment、Service 与 NetworkPolicy。
console 和外部客户端访问 api；网关与 Agent 运行时访问 dataplane；worker 消费 pg-boss 作业。
dataplane 至少两个副本，并配置 PodDisruptionBudget。

启动预置由 worker 单例作业维护。各入口接入 OpenTelemetry Node SDK，记录授权耗时、kagent 请求速率与进程内存。
Actor JWKS 优先验证 agentgateway 经 BackendTLSPolicy 直连 `ate-idp-server` 的能力，通过后收敛现有 9092 中转。

验收覆盖滚动发布、逐 Pod 终止、网关重试、审批与续接恢复，以及各角色的网络准入。
性能对照授权 p99、平台就绪时长、内存与 kagent 请求速率。

## 语音单链路

听写、朗读和通话统一由 LiveKit Agents 承载，STT / TTS 使用其插件。
`StartVoiceSession` 按模式创建语音会话并签发 LiveKit 令牌。

通话轮次在 voice worker 中编排。worker 以工作负载身份访问 api，
调用范围绑定对话及会话发起人的权限。浏览器负责音频与交互。

统一会话替代现有的 `TranscribeAudio`、`SynthesizeSpeech`、`StartVoiceCall` 与 `EndVoiceCall`，
并收敛 `server/speech`、`shared/browser/speech` 和浏览器通话桥接。
音频链路依赖随统一会话调整。

验收覆盖首个转写片段、首段音频、打断延迟、后台运行、短暂断网恢复，以及会话绑定、有效期与权限校验。
此项在进程拆分后实施。

## 逐资源授权

团队归属、资源分享与继承关系属于后续业务 ACL。当前应用角色、执行委派与目标系统授权见[执行授权](docs/execution-authorization.md)。

| 边界 | 目标 |
| --- | --- |
| 资源 | 稳定标识、团队归属，区分读取、调用、配置与授权管理 |
| 关系 | 所有者、成员、只读分享与资源继承 |
| 执行 | 绑定授权版本、父子资源子集与撤销生命周期 |
| 读取 | 列表、分页、缓存、订阅与知识检索使用相同的主体范围 |
| 凭据 | 用户 OBO 与服务身份桥接遵守相同资源上限 |
| 审计 | 原生执行历史关联授权决定与变更记录 |

关系授权采用成熟组件及其官方模型、SDK 与一致性语义。
验证覆盖两个用户、两个 Agent、两组资源，以及撤销、授权服务故障、令牌续期、重启和外部副作用后的恢复。

## 运维与上游

- CNPG 持续备份，以及执行凭据和 Actor 签名密钥的轮换演练。
- kagent 与 Substrate 的版本回归和本地补丁收敛，分别见 [kagent 扩展](runtime/kagent/README.md)与 [Substrate 修复](runtime/substrate/README.md)。
