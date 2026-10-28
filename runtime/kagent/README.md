# kagent 运行时构建

控制平面与三个 Harness 从 [pood1e/kagent](https://github.com/pood1e/kagent/tree/a144127e59c2aa756d8c18d88c0e3dd9191a6227) 的固定提交 `a144127e59c2aa756d8c18d88c0e3dd9191a6227` 编译，基于上游 `v1.0.0-alpha17`。官方同版本镜像提供运行环境，构建元数据记录实际源码提交。

- MemoryService 支持按身份管理知识及单条删除，用户范围取自认证主体，Actor 范围取自当前会话。平台执行入口将实际发起人映射到私有记忆，团队知识通过固定知识范围访问。
- 持久化接口采用上游 `kagent.runtime.v1` 及 `kagent-runtime` audience 的 Actor JWT。模型、向量与 MCP 请求携带身份占位头，由宿主替换为限定到 origin 的 Actor JWT，身份头由宿主独占注入。
- Claude 使用官方工具筛选参数和统一 PreToolUse hook，按 MCP 绑定的精确工具白名单执行，受审批约束的调用沿用上游持久化暂停与恢复。
- 首次准备策略保留技能来源的出站访问，普通会话凭据独立注入。关联的 Substrate 修复见 [启动网络](../substrate/README.md)。
- 原生 Actor 认证验证当前会话绑定，再由配置的 authorizer 约束资源范围；TaskStore 与 Memory 请求逐次检查当前授权。
- MCP 发现通过配置的网关和投射的 Kubernetes 服务账户凭据访问受管服务。

HITL、工具调用元数据与协作 MCP 类型采用 `kagent.api.v1` proto，源码及版本记录位于 [third_party/kagent](../../third_party/kagent/README.md)。平台原生持久化入口通过携带原始 Actor JWT 的 `SessionService.GetSession` 获取当前会话；自定义网关 audience 的凭据由对应接入层校验。

CI 校验全部 vendored proto 与该提交一致，在 PostgreSQL 18/pgvector 上验证范围隔离、授权撤销、原生持久化、协作 MCP、工具筛选、审批恢复及模板准备，随后执行上游 lint 并构建 controller 与三个 Harness。
