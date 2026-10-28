# 身份与授权集成验证

日期：2026-10-20。此记录对应早期集成环境，当前边界见[执行授权](../../docs/execution-authorization.md)，
现行组件版本见[架构](../../docs/architecture.md)，验证入口见[真实组件验证](README.md)。

## 原生身份链路

基线为 kagent 1.0.0-alpha11、Substrate 0.5.0-alpha2、宿主出站网关 2.6.3、
ate-idp-server 0.6.0-alpha3 与 MCP 网关 1.6.0。宿主出站镜像为
`gsoci.azurecr.io/giantswarm/agentgateway-upstream/agentgateway:2.6.3@sha256:dbca0e92a69ba08a6ca28e471495df846ca35e55b9fbe91234187e17b6409a5a`。

| 链路 | 验证结果 |
| --- | --- |
| Actor 身份 | 实际 MintActorJWT 签发，经官方 JWKS 校验 Actor UID 与 Session |
| 宿主注入 | Agent 发送占位头，接收端核对签名身份与工具调用 nonce |
| 多轮与恢复 | 同一 Session 连续执行、暂停和恢复后再次核验身份 |
| 逐次授权 | 允许范围内调用，越界调用返回权限错误，接收端计数保持原值 |
| 无效凭证 | 伪造签名、错误受众、过期令牌、重复身份头和未知方法均返回相应错误 |
| 协议 | 官方 Substrate proto 生成 TypeScript 与 Python，发布包携带契约 |

## 用户 OBO 与目标权限

实际 Keycloak 26.8.1 与 NetBox 4.7.2 参与验证。
两个临时 GitLab 用户经 Authorization Code、PKCE S256 与标准令牌交换，
交换后的主体保持原用户，受众限定为 `aiops-real-kubernetes`，有效期为 120 秒。

| 用户状态 | 读取 ConfigMap | 创建 ConfigMap |
| --- | --- | --- |
| aiops 组成员 | 200 | 201 |
| 非成员 | 200 | 403 |
| 退组后重新登录 | 200 | 403 |

提供方策略覆盖 scope、受众和客户端准入，刷新与注销按提供方生命周期核验。
NetBox 只读服务身份通过 HTTPS 完成读取，写请求返回权限错误。

测试使用隔离 realm、工作负载与会话，结束后清理测试资源并恢复站点部署，健康检查通过。
