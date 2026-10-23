# 环境 Chart 验证

2026-10-23，平台 0.27.0 重构分支，Helm 3.22.0、Kubernetes 1.37.1。

- `agentos-environment` 的 35 个资源、`agentos-connections` 的 68 个资源通过 kubeconform 严格校验及目标 API Server 的严格 dry-run。
- 14 项 helm-unittest 覆盖环境认证、受众、凭据占位符解析、非法配置、Helm 所有权与环境移除。
- Conftest 校验跨资源引用、身份工具视图、传输鉴权、TLS 主体、资源所有权与凭据展开。

使用独立的 `agentos-0270-ownership` 命名空间验证连接 Chart，测试后删除命名空间；未创建 Pod。

| 操作 | 结果 |
| --- | --- |
| 安装 | 预置 Backend、RemoteMCPServer、路由由同一 Helm release 管理 |
| 升级为零环境 | 预置连接回收，平台创建的连接保留 |
| 回退到原 revision | 预置连接恢复，用户连接与 AgentTemplate 的 UID、配置保持一致 |
| 卸载 | release 资源回收，用户连接保留 |

站点接管旧资源的 release 清单与所有权调整在最终切换窗口完成。身份撤销由方案包和目标环境的原生接口负责，平台先解除模板工具引用。
