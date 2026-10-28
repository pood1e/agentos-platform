# 执行身份与授权

## 用户与资源管理

认证用户可聊天、浏览配置和检索团队知识。应用角色授予配置管理能力，目标系统写角色决定执行的写权限上限；目标系统继续执行自身授权。

| 应用角色 | 管理范围 |
| --- | --- |
| `agentos-agents-manage` | Agent、Skill / 工具绑定、运行配置与角色起草 |
| `agentos-skills-manage` | 共享 Skill 目录 |
| `agentos-mcp-manage` | MCP 连接与凭据 |
| `agentos-knowledge-manage` | 团队知识新增、删除、清空与 Agent 写入 |
| `agentos-models-manage` | 模型连接与凭据 |
| `agentos-harnesses-manage` | Harness 配置 |

角色可以组合；IdP 可用 `agentos-admin` 组合角色并在令牌中展开实际权限。
管理 RPC 与浏览器共用 proto `Capability`，契约包的 `authorization.json` 由同一协议生成，供站点映射身份。

## 执行权限

会话创建时固定发起人、Agent、根 / 父会话、写权限及平台能力上限。每次工具调用取当前用户凭证、会话及父链权限、Agent 已选工具和环境身份范围的交集。
工具须出现在当前 generation 的就绪 AccessPlan 中；权限提升后的执行使用新会话。

执行绑定与用户凭据存于 PostgreSQL 的 `agentos_authorization` schema，委派链以递归查询读取。
access / refresh token 使用 AWS Encryption SDK 信封加密，密钥由独立 Kubernetes Secret 持久保存；原生会话与消息只使用身份引用。

原生 HITL 批准前复验当前执行授权，实际工具调用再次校验。控制台提交的决定必须完整对应当前原生暂停中的工具；用户拒绝与补充信息直接回复原生交互。
停止经 A2A 取消会话内执行与委派，确认后可继续同一会话；删除会话撤销其绑定和后代授权。
业务审批规则、审批人资格、工单与业务执行守卫由方案包或环境服务实现。

## 运行时与工作负载

| 调用方 | 凭据 | 校验范围 |
| --- | --- | --- |
| 原生 TaskStore / Memory | `Authorization` 中 `kagent-runtime` audience 的 Actor JWT | 保留原始凭据，通过 kagent `SessionService.GetSession` 验证当前 Actor 与 Session，再约束持久化范围 |
| Agent 模型 / MCP 调用 | 宿主注入的 Actor JWT，audience 对应目标 origin | 签名、issuer、audience、当前 Actor / Session、执行授权与工具绑定 |
| kagent 工具发现 | 绑定 ServiceAccount JWT，audience `agentos-mcp-discovery` | TokenReview 与精确控制器主体，只开放发现等元数据方法 |
| 平台知识嵌入请求 | 绑定 ServiceAccount JWT，audience 为模型入口 | 配置的嵌入模型与 `/v1/embeddings` |
| 外部执行服务 | 登记的 OIDC client credentials JWT | issuer、audience、azp、sub 与授权 Agent 范围 |

TaskStore 请求限定到当前会话，原生持久化继续校验 dispatch 与版本围栏；撤权后仍可记录清理和终态。
私人 Memory 写入限定当前用户、Agent 与启用记忆的 Harness；共享知识写入另需知识管理角色。
管理 RPC 与 A2A 向控制面开放，运行时出站策略和 NetworkPolicy 限制直连。

模型与 MCP 接入通过 JOSE 验证 Actor。原生 `ate-idp-server` 发布签名公钥，dataplane 使用投射的原生信任根读取 JWKS，并在 HTTP/1.1 端口 9092 的 `/keys/actor` 转发给网关控制器。
网关沿用原生 5 分钟刷新间隔；轮换保留覆盖未到期令牌与缓存窗口的旧公钥。
Harness 的 `x-substrate-actor-token` 占位头由宿主替换，ModelConfig 占位值只用于 SDK 初始化。

TokenReview 显式指定 audience，核对审核结果与精确 ServiceAccount 主体，每次请求重新审核。
平台 API 逐次读取投射卷中的短期令牌；环境发现经 HTTP 外部鉴权，平台 MCP 与模型入口由各自处理器审核。

## 环境授权

每个环境身份对应机密客户端 `agentos-<identity>`。逐调用授权通过后，openid-client 换取环境资源令牌：用户执行采用 RFC 8693 并保留 `sub`，服务执行与目录发现采用 client credentials。
环境网关验证 issuer、audience、有效期，并要求 `/mcp/<identity>/<service>` 的 `azp` 对应执行客户端。
平台到环境网关使用 HTTPS，校验 CA 与 SAN。

连接器使用 agentgateway BackendAuth：OAuth 目标交换为目标受众令牌，API 令牌目标使用每身份有限期凭据。
网关移除 Actor JWT，API 令牌路由另移除环境 Authorization；连接器只接收目标凭据，每次 MCP 请求独立认证。
API 令牌目标的原生审计记录服务账号，平台执行元数据保留实际发起人。配置见[环境接入](environments.md)。

## 登录与离线授权

API 接受 Bearer 访问令牌。web 通过 oauth2-proxy 完成授权码与 PKCE 登录，Cookie 使用 Secure、HttpOnly、`SameSite=Lax`，转发请求时注入访问令牌。
后台执行使用独立离线授权：`GetAccessProfile` 返回 `delegated` / `delegation_url`；尚未授权的 `SendMessage` 返回 `FAILED_PRECONDITION`（`delegation.required`）。

`/delegation/start` 通过授权码、PKCE、state 与 nonce 请求 `offline_access`。`return_to` 限定为登记前端源，授权事务保存在 10 分钟签名 Cookie 中，refresh token 在服务端加密保存。
浏览器退出或访问令牌到期后，任务可凭离线授权继续；授权失效、账号禁用或 IdP 拒绝续期时停止后续调用。

同一用户的刷新在进程内合并，并经 PostgreSQL 行锁跨副本串行执行。新令牌反映当前角色，执行仍受会话初始权限上限约束；IdP 变更的传播窗口由现有 access token 有效期决定。

## 数据归属

聊天通过 `entryAgent` 进入统一助手，角色起草采用独立管理流程。
OIDC 用户的会话、任务、消息、工具参数与实时订阅按发起人隔离，服务端在搜索、计数、分页及执行树投影前过滤归属。
历史读取独立于任务取消和凭据续期；平台管理员可读取共享服务任务，个人私聊仍按发起人隔离。

浏览器缓存按工作空间与用户分区。私人记忆范围由服务端执行身份确定，会话发现限定同一执行树；显式团队知识在工作空间内共享。
