# 真实组件验证

执行归属、持久凭据、取消传播、网关目标选择与工具发现由 [kagent fork](https://github.com/pood1e/kagent/tree/main) 的 PostgreSQL、Kubernetes API Server 与真实 agentgateway 集成测试验证。
原生镜像流水线运行 `grpcserver` 授权回归：官方 MCP SDK 验证已选工具、用户 subject_token 交换、错误受众与同连接撤权；发现凭据通过真实 CRD 与 OAuth2 / TokenRequest 验证。
平台侧验证请求凭据透传、原生可信引用投影、单次取消、CAS 冲突与错误映射，入口为 `npm test`。

## Keycloak Token Exchange

使用实际 Keycloak 管理账号的凭据文件，脚本创建随机命名的独立 realm，采用官方 Admin Client 与 openid-client，结束后删除该 realm。
初始用户令牌通过测试 realm 的 Direct Access Grant 取得；平台登录采用 Authorization Code 与 PKCE，见[执行授权](../../docs/execution-authorization.md#执行与凭据)。

```sh
PROOF_KEYCLOAK_URL=https://identity.example.test \
PROOF_KEYCLOAK_ADMIN_PASSWORD_FILE=/run/proof/keycloak-admin \
npx tsx tests/proofs/keycloak-exchange.ts
```

`PROOF_KEYCLOAK_ADMIN_USERNAME` 默认 `admin`。`PROOF_KEYCLOAK_ADDRESS` 可指定验证站点的连接 IP，证书主机名与 TLS 校验继续使用配置 URL。
测试覆盖两个用户、只读角色 scope、交换客户端限制、目标 API 读写权限、额外 scope、错误 audience、用户刷新与注销。
客户端策略来自 `tests/proofs/keycloak-policy.json`。
