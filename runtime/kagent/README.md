# kagent 控制平面扩展

基础版本为 `1.0.0-alpha17`，源码提交 `8392184232e9c78196433a34b1fd3b33db5fcb97`。`platform.patch` 集中维护平台所需扩展。

- MemoryService 支持按身份管理知识及单条删除，用户范围取自认证主体，Actor 范围取自当前会话。平台执行入口将实际发起人映射到私有记忆，团队知识通过固定知识范围访问。
- 持久化接口采用上游 `kagent.runtime.v1` 及 `kagent-runtime` audience 的 Actor JWT。模型、向量与 MCP 请求携带身份占位头，由宿主替换为限定到 origin 的 Actor JWT，身份头由宿主独占注入。
- Claude 使用官方工具筛选参数和统一 PreToolUse hook，按 MCP 绑定的精确工具白名单执行，受审批约束的调用沿用上游持久化暂停与恢复。
- 首次准备策略保留技能来源的出站访问，普通会话凭据独立注入。关联的 Substrate 修复见 [启动网络](../substrate/README.md)。

CI 在 PostgreSQL 18/pgvector 上验证范围隔离、删除、原生持久化、工具筛选、审批恢复及模板准备，随后执行上游 lint 并构建 controller 与三个 Harness。协议从同一份上游 proto 生成。

上游提交：[Actor 身份头 #3401](https://github.com/kagent-dev/kagent/pull/3401)、[Memory 身份范围 #3402](https://github.com/kagent-dev/kagent/pull/3402)、[Harness 工具约束 #3403](https://github.com/kagent-dev/kagent/pull/3403)、[准备策略 #3404](https://github.com/kagent-dev/kagent/pull/3404)。所选发布版本包含能力并通过站点回归后移除对应补丁。

原生子任务续接由 [#3244](https://github.com/kagent-dev/kagent/issues/3244) 跟踪，发布版本具备同等能力并通过回归后，由原生链路替代平台续接协调。
HITL 与工具调用元数据随上游公开协议收敛，平台补充定义位于 `proto/agentos/kagent/v1/wire.proto`。
