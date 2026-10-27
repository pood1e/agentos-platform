# 环境 Chart 验证

Helm 4.3.1，Kubernetes API 1.37。

- `agentos-environment` 的 41 个资源、`agentos-connections` 的 88 个资源通过 kubeconform 严格校验。
- 12 项 helm-unittest 覆盖认证、受众、凭据占位符、非法配置与环境移除。
- Conftest 校验跨资源引用、身份工具范围、TLS 主体和只读上限。
- 控制器的 API Server 集成测试覆盖 reconcile 中断恢复、预置更新、用户所有权及缺少凭据后的恢复。
- 原生 OCI 测试覆盖签名、错版本、错提交、篡改制品与重复拉取；四套 Chart 和 collection 重复打包保持一致。

Chart 声明 AccessPlan，控制器拥有派生连接与身份路由。目标系统凭据由环境的原生 API 管理。
完整站点的网关请求、OAuth 交换与 microVM 执行由站点回归验证。
