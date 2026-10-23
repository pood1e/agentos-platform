# 执行身份与授权

## 平台边界

认证用户均可发起聊天和只读查询。平台资源管理权限由受信令牌的应用角色分别授予；目标系统写角色仅决定运维执行的写权限上限。会话创建时固定发起人、Agent、根会话、父会话、写权限与平台能力上限；权限提升后的任务使用新会话。

| 应用角色 | 管理范围 |
| --- | --- |
| `agentos-agents-manage` | 智能体配置、技能与工具绑定、运行配置、角色起草助手 |
| `agentos-skills-manage` | 共享 Skill 目录 |
| `agentos-mcp-manage` | MCP 连接及其凭据 |
| `agentos-knowledge-manage` | 团队知识的新增、删除、清空与 Agent 写入 |
| `agentos-models-manage` | 模型连接及其凭据 |
| `agentos-harnesses-manage` | Harness 配置 |
| `agentos-tasks-manage` | 系统任务的定时配置、手动触发和共享标签 |

角色可以组合。身份提供方可将 `agentos-admin` 定义为包含全部资源角色的原生组合角色，并在令牌中展开实际权限。认证用户可浏览智能体、Skill、MCP、模型接入、Harness 和团队知识的列表与详情，并检索团队知识。平台依据 proto 定义的 `Capability` 校验管理 RPC；浏览器使用相同能力控制新增、修改、删除和运行配置。系统任务使用管理角色限制。发布包的 `authorization.json` 由同一协议生成，供环境配置身份映射。

应用角色授予配置管理能力；目标系统仍执行自身授权。平台管理角色保留用户私聊归属边界。

个人任务的标签由发起人维护，包括已结束或已撤销执行权的任务；共享服务任务的标签需要任务管理角色。标签作为操作根任务的元数据保存在同一 PostgreSQL 的 `agentos_console.task_tags` 表中，以工作空间隔离并采用乐观锁更新。标签只用于分类和筛选，执行状态、审批结果与目标系统写权限独立校验。

执行绑定与最新验证的用户凭证以 protobuf 保存于 PostgreSQL 的 `agentos_authorization` schema。记录采用 AES-256-GCM 加密，认证数据包含工作空间、记录类型和 ID；加密密钥位于独立、持久保留的 Kubernetes Secret。
原生会话、A2A 消息与工具参数仅保存身份引用，不携带用户访问令牌。

平台在每次工具调用时计算用户当前凭证、会话及父链权限、Agent 当前已选工具与环境身份上限的交集。未知工具默认拒绝。委派与自动续接校验相同的根会话及发起人。取消会话撤销其执行绑定，后代会话同步失去工具执行权；重新工作使用新会话。

原生 HITL 与外部审批均先校验执行权限。外部工单创建前、审批完成后恢复前、工具实际调用时分别复验。批准只确认操作，不扩大执行权限。

## 运行时边界

Substrate 宿主机为每个出站目标注入短期 Actor JWT。平台验证签名、issuer、audience、当前 Actor UID 与原生 Session，运行时无法通过参数指定其他用户或会话。

运行时 API 仅注册上游 TaskStoreService、MemoryService。TaskStore 请求固定到签名 Actor 对应的会话，原生持久化接口继续校验 dispatch 和版本围栏；撤销后仍可记录清理及终态。私人 Memory 写操作限定当前用户、当前 Agent 和启用记忆的 Harness；团队共享记忆另须 `agentos-knowledge-manage`，不受运维写角色替代。
管理 RPC 与 A2A 入口仅向控制面开放。运行时出站策略与 NetworkPolicy 同时限制直连原生控制器。

Actor 公钥发现由官方 `ate-idp-server` 提供，服务证书及信任根使用 Substrate 的原生 PodCertificate 与 ClusterTrustBundle。
托管 Harness 的原生客户端与 MCP 编译配置发送 `x-substrate-actor-token` 占位头，宿主替换为签名凭证。自定义 Harness 使用相同的请求头和原生持久化协议。

## 平台工作负载

| 调用方 | 认证 | 准入范围 |
| --- | --- | --- |
| Agent | Substrate Actor JWT，按模型与 MCP 入口区分 audience | 当前 Actor、Session、执行授权、模型配置或模板工具绑定 |
| kagent 控制器 | 绑定 ServiceAccount JWT，audience `agentos-mcp-discovery` | initialize、ping、工具发现等元数据方法 |
| 平台 API | 绑定 ServiceAccount JWT，audience 为模型入口 | 配置的团队知识嵌入模型与 `/v1/embeddings` |
| 环境自动化 worker | 已登记环境的 client credentials JWT | 对应环境的案例运行、观察与取消 |

平台模型与协作 MCP 分别使用独立入口 audience。每个平台 MCP 服务只注册一次，ExtMCP 按具体服务及工具校验当前 Agent 的绑定，工具同名不会跨服务授权。
自动化客户端精确匹配 issuer、audience、azp、服务账号 sub，人工用户令牌或其他环境客户端无法接管该入口。

原生 Harness SDK 使用 ModelConfig 的非空占位值完成客户端初始化，实际授权依赖宿主注入的 Actor JWT；占位值不授予权限。平台 API 从 Kubernetes 投射卷逐次读取轮换后的短期令牌。

## 环境与方案包边界

每个环境身份对应机密客户端 `agentos-<identity>`。平台在逐调用授权通过后，以 openid-client 获取环境资源受众的短期令牌：用户执行采用 RFC 8693，服务执行与目录发现采用 client credentials。环境网关验证 issuer、audience 与有效期，路径 `/mcp/<identity>/<service>` 的 `azp` 必须对应执行客户端。

平台网关到环境网关使用 HTTPS，cert-manager 签发证书，Backend 校验 CA 和 SAN。原生控制器使用可刷新的 Kubernetes 绑定 ServiceAccount 令牌发现工具；Agent 的握手、发现和调用使用 Actor JWT。两者均由平台网关认证，工具调用继续经过执行绑定与已选工具检查。

连接器的 `auth` 使用 agentgateway 原生 BackendAuth。Kubernetes、Keycloak 与 Grafana 采用目标受众令牌交换，保留发起人 `sub` 与执行身份 `azp`；仅支持 API 令牌的目标使用每身份有限期凭据。环境网关移除 Actor JWT，API 令牌路由同时移除环境 Authorization，连接器只收到目标凭据。MCP 后端采用无状态路由，每次调用独立认证。

审批规则、业务工具分级、目标角色和凭据轮换由方案包与运维环境管理。平台无需依赖 GitLab、Keycloak 或 Kubernetes 的业务角色名称。API 令牌目标的原生审计记录目标服务账号，平台执行元数据保留实际发起人。

## 凭证与生命周期

OIDC 登录使用授权码、PKCE、state 与 nonce，并请求标准 `offline_access`。浏览器持有仅含用户主体的 Secure、HttpOnly、SameSite Cookie；访问令牌和离线 refresh token 加密保存在服务端执行存储，不进入会话消息、工具参数或运行时。

后台任务按需续期短期 access token，再以原用户令牌执行 OBO。普通浏览器退出、关闭页面和 access token 到期不撤销已授权任务。离线授权失效、账号禁用或身份提供方拒绝续期时停止后续调用；取消任务立即撤销其执行绑定及全部后代，不以服务身份接管。无人值守系统任务使用独立的显式服务身份。

同一用户的刷新通过 PostgreSQL 行锁串行执行，支持进程重启与多个控制台副本。新令牌反映当前角色，执行时始终与会话创建时的权限上限相交；权限提升不会扩大既有任务。短期令牌尚有效时，身份提供方变更的传播上限由 access token 有效期决定。

`identity.mode: none` 使用共享访客身份，保留 Agent 工具上限、Actor 身份验证与目标系统权限。此模式没有独立用户身份，访客共享聊天记录。

## 会话与数据归属

普通聊天只通过 `entryAgent` 配置的统一助手进入，由助手委派专业 Agent。配置编辑中的角色起草使用独立的受控管理流程。

OIDC 用户的聊天、任务、消息、工具参数、审批与实时订阅按执行绑定的发起人隔离。服务端在搜索、计数、分页与操作树投影前过滤归属；写角色同样无法查看其他用户的私人会话。取消执行或原凭证过期不影响本人读取历史。未绑定发起人的旧记录不对用户展示。

浏览器历史定位与查询缓存按工作空间和用户主体分区。运行时私人记忆的用户范围由服务端从执行身份确定；会话发现限定在同一执行树。显式团队知识与服务身份发起的自动化运维记录在工作空间内向平台管理员共享。

逐资源业务 ACL 的后续范围见[授权实施计划](authorization-plan.md)。
