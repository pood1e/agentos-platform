# 执行身份与授权

## 用户与资源管理

浏览器登录、Cookie 与访问令牌刷新由 oauth2-proxy 和站点 IdP 维护。平台逐次将原始 Bearer 凭据传给 kagent；`SystemService.GetCurrentUser` 提供规范主体和有效 scope。
应用角色映射为 proto `Capability`，契约包的 `authorization.json` 由同一协议生成。

私有 IdP 的信任根通过 `identity.caCertificateRef` 引用当前命名空间的 ConfigMap key，供浏览器登录使用；站点安装器将其同步接入 kagent 原生 OIDC 与断言授权配置。

| 应用角色 | 管理范围 |
| --- | --- |
| `agentos-agents-manage` | Agent、工具 / Skill 绑定、运行配置与角色起草 |
| `agentos-skills-manage` | 共享 Skill 目录 |
| `agentos-mcp-manage` | MCP 连接与凭据 |
| `agentos-models-manage` | 模型连接与凭据 |
| `agentos-harnesses-manage` | Harness 配置 |

kagent 的 OIDC `ResourceScopeRule` 按资源类型与操作授予原生权限。资源更新使用原生编译准入与 `resourceVersion` CAS。站点写角色限制环境写工具；目标系统继续执行自身授权。

## 执行与凭据

kagent 创建 Session 时固定发起人、Agent、父 / 根关系和权限上限。委派继承祖先上限，运行时每次解析当前委托凭据和 scope；授权提升用于新会话，撤权沿原生父链生效。
原生 `TaskExecution` 记录可信父任务、根任务、同步 / 后台关系及 HITL 续接引用。messageId 幂等、忙碌、删除围栏与取消传播均由原生执行服务维护。

用户以自身 Bearer 调用 `ConsoleService.RegisterDelegationCredential` 登记后台委托，console 加载时自动登记。
kagent 以 Ed25519 密钥签发一次性 RFC 7523 断言，在 IdP 令牌端点换取该用户的访问令牌并核对主体一致；IdP 仅接受已关联断言签发方的用户。
委托主体与当前令牌存于 kagent，采用原生 32 字节密钥加密，续期使用带租约的 CAS。IdP 永久拒绝时撤销授权树，临时故障阻止后续凭据出口；数据库事务仅覆盖本地状态更新。

原生 HITL 回复、继续执行和工具调用分别复验当前权限。控制台提交原生确认 / 提问响应，业务审批规则与审批人资格由方案包维护。

## 运行时与网关

| 调用方 | 凭据与范围 |
| --- | --- |
| Actor TaskStore / Memory / 原生协作 MCP | Substrate Actor JWT，受众 `kagent-runtime`；原生服务核对 Actor、Session 与执行范围 |
| Actor 模型 / 业务 MCP | `x-substrate-actor-token` 中目标 HTTP(S) origin 的 Actor JWT；网关验证 JWKS 后向 kagent 查询当前权限与 Session 固定 revision 的目标 |
| 工具目录发现 | `RemoteMCPServer.spec.discoveryAuth` 的 OAuth2 client credentials 或短期 ServiceAccount TokenRequest；权限限定元数据 |
| 外部自动化 | 受限机器 OIDC 身份直接调用原生 A2A；由原生 ResourceScopeRule 约束资源类型与操作 |
| 语音 worker | API 私有签名的 LiveKit metadata 携带原生短期 Session 凭据；每次操作复验原生授权 |

agentgateway 通过 `runtime.actorJWKS` 直接读取 Substrate HTTPS JWKS，校验 CA 与 SAN；`runtime.actorIssuer` 与原生签发方一致。
kagent 的 `gatewayAudiences` 登记实际模型和 MCP HTTP(S) origins，包含环境服务独立入口；原生运行时受众与网关受众分别校验。

模型授权限定当前 Session revision 中的 ModelConfig；MCP 授权同时满足静态工具分级与 revision 的已选工具。原生 `/authorize/runtime` 回调逐次查询，返回 `no-store`。授权结果放在 `X-Kagent-Selection` 响应头（MCP Apps 为 `x-agentos-selection`），extAuth 元数据只读响应头，代理的流式响应按原样逐帧转发。
业务 MCP 的独立路由按目标 origin 校验 Actor JWT 受众，并执行各自的原生授权回调；共享网关仅校验签发方与 Actor 身份。
环境凭据出口将当前发起人的 IdP access token 作为 RFC 8693 `subject_token`，agentgateway 再交换目标资源令牌；Actor JWT 保持来源证明，目标服务只收到目标凭据。

## 数据归属

Session、任务、消息、历史与订阅的归属由 kagent 授权过滤。平台 read model 仅投影已经授权的原生结果；浏览器缓存按工作空间与主体分区。
智能体活动、工作记录与业务指标共享个人或系统执行范围。管理员通过 `system_only` 查询当前工作空间内其他发起人的已授权执行，控制台的任务历史、智能体团队与工作流执行历史提供「我的 / 系统」切换；个人范围维持当前主体的会话归属。分页游标同时绑定主体、智能体、状态和执行范围。
Agent 记忆按 Agent 与发起人限定。会话列表可按原生根 Session 限定；语音凭据仅访问绑定 Session 与对应 Agent。
