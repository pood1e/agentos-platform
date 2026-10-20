# 0.5 平台边界迁移

| 归属 | 能力 |
| --- | --- |
| agentos-platform | 原生 Agent 与会话、执行读模型、工具确认、外部审批协议、知识、测评与环境接入 |
| aiops-mvp | 运维团队、ChangePlan、prepare_change MCP、Zammad 审批、变更执行台账与 ExtMCP 守卫 |

会话 RPC 以原生 `ResourceReference agent` 替代固定会话类型；`CaseReference`、`CaseTrigger` 显式选择 Agent。原生 task 是默认任务单位，`agentos.dev/task-scope: session` 选择多轮会话聚合。

执行状态、任务运行与工具调用定义在 `agentos.execution.v1`。审批展示读取 `ListApprovals`，原生工具确认通过 `RespondInteraction.approval` 提交。环境连接使用 `GovernanceConfig`，由 `AGENTOS_GOVERNANCE_CONFIG` 加载，Chart 挂载 Secret `agentos-governance`。

AIOps 部署自己的审批服务和执行守卫，再通过环境连接登记 ApprovalService 地址及凭据。持久化 AgentTemplate 的旧工具绑定与提示词由 aiops-mvp 的一次性迁移更新；该迁移保留现有数据库和工单记录。控制台与业务服务同时升级到 0.5 契约，协议直接切换。
