# 工作负载身份验证

2026-10-23，平台 0.27.0 重构分支，原生 agentgateway v1.6.0，使用测试专用 RSA 密钥和隔离的本地服务。

| 链路 | 结果 |
| --- | --- |
| 控制器绑定 SA → 平台网关 → 协作 MCP | initialize 与 tools/list 成功；tools/call 返回权限拒绝 |
| Actor JWT → 平台 ExtMCP → 协作 MCP | 已绑定工具成功；未绑定工具拒绝 |
| Actor JWT → 模型 HTTP 授权 → SSE 后端 | 已配置模型成功，首段 4–5 ms、末段约 305 ms；跨模型与跨 audience 请求返回 403 |
| 撤销执行绑定后的 Actor 模型请求 | 403 |
| 环境 client credentials → 原生 MCP 网关 → 平台自动化 | 仅发现案例运行、观察与取消工具 |
| 自动化令牌使用其他 audience | 403 |

验证使用 Chart 渲染出的 JWT 提供方、授权表达式与模型请求上下文，配合平台实际 ExtMCP、HTTP 授权和 MCP 入口；
Kubernetes 的 Service appProtocol 在本地配置中对应显式 HTTP/2 上游。服务与执行注册使用隔离测试替身。

持续回归覆盖 `workloads.test.ts`、`platform-tool-authorization.test.ts`、`model-authorization.test.ts`、`team-auth.test.ts`、
`mcp-permissions.test.ts`、`executions.test.ts` 与 `offline.test.ts`。模型授权响应在后端认证前消费工作负载 Authorization，随后由原生后端注入提供方凭据；自托管无凭据与带 API key 的后端均通过，平台 SA 嵌入请求成功且令牌未透传。

站点切换另验用户退出后的后台 OBO、令牌轮换、
真实 Actor UID、环境服务账号及无浏览器 OIDC 部署。
