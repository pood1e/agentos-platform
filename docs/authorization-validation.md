# 身份与授权链路验证

日期：2026-10-20。阶段：授权基础验证与控制台 OIDC 接入。

## 固定组件

| 组件 | 验证版本 |
| --- | --- |
| kagent | 1.0.0-alpha11，平台已有补丁 |
| Substrate Control API | 0.5.0-alpha2，平台已有补丁 |
| 宿主机出站网关 | Giant Swarm agentgateway-upstream 2.6.3，`sha256:dbca0e92a69ba08a6ca28e471495df846ca35e55b9fbe91234187e17b6409a5a` |
| Actor JWKS 服务 | 官方 ate-idp-server 0.6.0-alpha3，使用现有签名池 |
| MCP 网关 | 官方 agentgateway 1.6.0 |
| 授权服务与工具 | OpenFGA 1.22.0、CLI 0.8.2、官方 Node SDK 0.9.7 |
| 身份 SDK | JOSE 6.2.13、openid-client 6.8.8、Keycloak Admin Client 26.8.1 |
| OAuth 与桥接目标 | Keycloak 26.8.1、NetBox 4.7.2 |

已有出站网关 2.3.6 无法执行 ActorJWTSource 注入：真实 Agent 的 MCP 初始化被拒绝。2.6.3 使用兼容的原生 MintActorJWT RPC，通过实际工作负载验证。
JWKS 服务复用原生签名池，私钥只由原生签发组件持有。接收方验证签名、issuer、目标 audience、时间与 Actor 声明。

## 通过的检查

| 链路 | 证据 |
| --- | --- |
| 原生身份 | 实际 MintActorJWT 签发，官方 JWKS 校验，当前 Actor UID 与 Session 绑定 |
| 宿主机注入 | Agent 仅发送占位头；实际工具执行返回当前 Session、Agent 与 creator，返回内容不含 JWT |
| 多轮与恢复 | 同一原生 Session 连续执行，暂停并恢复后再次核对签名身份与新的工具调用 nonce |
| 网关逐调用 | 同一 MCP 连接中允许范围内调用、拒绝越界参数；拒绝时接收端执行计数不变 |
| 伪造输入 | 参数中的 session、initiator、grant 不替代签名身份；拒绝伪造签名、错误受众、过期令牌、重复身份头与未知方法 |
| 授权模型 | 两个主体、两个 Agent、资源范围、调用/编辑分离、会话隔离、只读分享、父授权过期与撤销 |
| SDK 故障语义 | 实际 OpenFGA 服务验证权限交集、父授权删除后的子授权拒绝、服务不可用拒绝及模型 ID 固定 |
| OAuth 用户代办 | HTTPS 连接实际 Keycloak，在临时 realm 中保留用户 sub、限制 audience 和角色；原生用户 API 读成功、写拒绝 |
| OAuth 权限收窄 | 提供方策略拒绝新增 scope、不可用 audience、未启用交换的客户端与无目标权限的用户 |
| 续期 | 用户登录令牌可刷新；注销后刷新被提供方拒绝；普通交换不签发 refresh token |
| 服务身份桥接 | HTTPS 连接实际 NetBox，既有只读服务 Token 读成功，写在对象查找前被拒绝 |
| 运行时补丁 | 七个补丁可依次应用至固定上游提交；Actor 身份注入按协议、主机与端口限制 audience，保留现有凭据规则 |
| 契约 | 官方 Substrate proto 生成 TypeScript 与 Python；Python wheel 包含 ateapi_pb2，Node 包包含对应契约 |

自动化入口为 `tests/proofs`，模型与 SDK 测试进入 CI。真实环境验证使用独立测试资源，身份提供方测试 realm 在结束后删除。
本次验证的临时工作负载与会话已清理，宿主机网关恢复原部署版本，站点健康检查通过。

## AIOps 环境的 GitLab 与 OBO 实践

环境为 `aiops-real`。GitLab 提供账号，现有 Keycloak 使用 OIDC 代理认证并根据受信组声明同步角色。
控制台支持 `none` 和 `oidc`，AIOps 站点选择 OIDC；签名、issuer、audience、有效期和写角色由 RPC 独立校验。

两个临时 GitLab 账号完成真实 Authorization Code、PKCE S256 与 Standard Token Exchange V2，交换后的 `sub` 与登录用户一致，audience 仅为 `aiops-real-kubernetes`，有效期 120 秒，无刷新令牌。
使用交换令牌直接访问真实 Kubernetes API，结果如下：

| 用户 | 读取 ConfigMap | 创建 ConfigMap |
| --- | --- | --- |
| `aiops` 组成员 | 200 | 201 |
| 无组成员关系 | 200 | 403 |
| 成员退组并重新登录 | 200 | 403 |

平台使用官方 Protobuf `NO_SIDE_EFFECTS` 选项声明只读 RPC，其余方法均要求写角色。测试覆盖无身份、伪造签名、错误 audience、只读拒绝写入及跨 Origin 拒绝。
Chart 验证覆盖两种认证模式；无 OIDC 模式不创建登录代理、不引用 OIDC 凭据。已有 49 个浏览器场景通过带签名身份的测试入口。

此实践验证环境用户代办与目标 RBAC。现有 Agent 连接器仍使用服务身份，逐任务用户授权绑定继续由后续执行边界交付。

## 实施决策

- 运行资源复用原生 Session、Actor、A2A Task 与生命周期 API。Actor JWT 表示工作负载身份；Session.creator 只表示创建者，当前发起者来自执行授权绑定。
- 信任边界位于平台 API、原生入口、ExtMCP 与目标 API。工具模型只能提出资源请求，授权服务从原生状态与持久关联解析主体和执行。
- 平台 OpenFGA 使用独立 store 和固定模型。Substrate 内嵌 OpenFGA 继续管理原生基础设施权限，其原生 AccessPolicy 模型与平台业务模型分别维护。
- 用户 scope 通过明确客户端 scope 和原生角色映射收窄。Keycloak 标准交换依赖同一 realm；跨 realm 或外部提供方的生产连接需要独立用户授权与身份关联验收。
- NetBox 首批采用服务身份桥接。实际账号的只读权限提供目标上限，业务资源过滤与用户许可由 AIOps 接线并在内容进入模型前执行。
- 浏览器登录会话交给 OAuth2 Proxy 维护；执行授权的服务端关联与令牌生命周期独立持久化，原生执行历史继续由 kagent 保存。

## 仍需完成的原生边界

当前原生 TaskStore 仍信任未签名的运行时身份头。kagent 的代理认证依赖外部验证，默认身份处理还可能转发后端 Authorization 到运行时；生产接入须关闭直接入口并在受信边界剥离后端凭据。

Substrate 0.5.0-alpha2 默认只强制校验 AccessPolicy 治理 RPC；部分身份签发与生命周期 RPC 的权限注册也不完整。
当前测试服务账号可以取得 Actor 与签发令牌，不能据此推断其权限已经最小化。生产前须补齐 RPC 覆盖、启用原生授权并限制网络入口与签发主体。

Actor JWT 当前绑定 Actor/Session，未直接包含 A2A Task。执行授权的 Task 关联需要原生受信调度与存储状态共同确定，启动、多轮、取消后的在途请求、并发与委派均需专项验证。
Native Session 的单活动 Task 约束不能单独作为逐执行身份绑定的完整证明。

签发服务还需维护不可变 grant 范围、父子资源子集与撤销生命周期；平台登录、读模型隔离、持续订阅、审批复验和生产迁移仍按 P1—P5 实施。
上述边界完成前保持 P0 状态，当前基础库不代表线上已启用完整用户授权。
