# 授权基础

`model.fga` 是平台关系模型，`*.fga.yaml` 使用 OpenFGA 官方测试格式。`npm run test:authorization` 验证模型；`npm test` 使用实际 OpenFGA 服务验证 SDK 适配。

| 对象 | 能力 |
| --- | --- |
| `principal` | 经认证的人类或服务主体，外部身份以 issuer 与 subject 区分 |
| `workspace` | 工作空间成员与管理员 |
| `agent` | 调用与配置编辑独立授权 |
| `session` | 私有会话、只读分享与操作分享 |
| `grant` | 发起者、受派 Agent、原生会话、期限与父授权的有效性 |
| `resource` | 主体许可、Agent 上限与执行授权范围 |

调用检查分别验证主体资源许可、Agent 资源上限、grant 资源范围、grant 有效性及其 Agent/Session 绑定，所有结果同时成立才放行。
`server/authorization/policy.ts` 固定模型 ID、较高一致性和服务端时间，拒绝不完整结果与外部 contextual tuples。

父授权的期限和撤销由模型递归约束。子授权的资源子集、期限上限、父子唯一性与无环关系由授权签发服务维护；当前模型与判定适配尚未提供该签发服务。
执行关联、当前 Task 和原生运行状态由受信服务读取，工具参数中的身份或授权 ID 不承担认证。

`server/authorization/actor.ts` 使用 JOSE 验证 Substrate Actor JWT，并核对当前 Actor UID 与原生 Session。
`server/authorization/mcp.ts` 实现官方 ExtMCP 协议，逐次读取 `tools/call` 的实际参数与签名身份，再调用资源授权适配。静态发现方法单独处理，其余方法默认拒绝。
连接解析使用网关提供的 serviceNames 与策略 metadata，资源适配只接收所需上下文。该 gRPC 接点由网关私有访问，HTTP 入口认证和网络边界由部署接线约束。

`keycloak/realm-policy.json` 使用 Keycloak 原生 RealmRepresentation 的客户端策略结构，启用 `downscope-assertion-grant-enforcer`。
交换客户端同时配置固定目标、明确的客户端 scope 和角色映射；客户端默认 scope、可选 scope 与 `fullScopeAllowed` 共同决定令牌范围。该策略在独立验证 realm 中测试，生产接入由平台身份服务管理。

入口接线、执行授权持久化和生产切换按[实施计划](../docs/authorization-plan.md)交付；当前验证结果见[链路验证](../docs/authorization-validation.md)。
