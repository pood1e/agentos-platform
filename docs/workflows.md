# 工作流

`/workflows` 管理原生 `AgentTemplate.workflowFrom` 与内联模板工作流。执行定义采用 kagent `adk.declarative/v0.2 AgentSystem`；React Flow 画布和 YAML 编辑同一份文档，节点属性来自原生生成的 schema。画布支持路由与嵌套子图，顺序、并行和循环 Agent 通过 YAML 配置。

工作流是独立的自动化能力，可组合逻辑、工具、人工交互与各种 Agent。工程师是可选的 Agent 参与者。原生 Agent 提供工作流的执行身份与 Harness 绑定，手动入口和业务调用共用这一原生执行入口。

## 发布与版本

```text
AgentSystem 文档 → WorkflowService 候选编译 → 不可变 ConfigMap
                                                  ↓
                                  Agent / AgentTemplate CAS 更新
                                                  ↓
                                 原生 revision 准备 → Session / Task
```

候选校验使用 kagent 的只读编译快照和 ADK 图构建检查。正文在编译前后均受 64 KiB 限制。发布通过内容寻址 ConfigMap 保存正文，以原生资源的 `resourceVersion` 切换引用；重试读回已提交结果。布局保存在定义资源的 `agentos.dev/workflow-layout` 注解中，独立于执行定义。

就绪判断对比当前 Agent 的原生编译 revision 与 `status.latestSuccessfulRevision`，共享模板的每个 Agent 分别解析其运行身份和依赖。执行历史使用通用 `ListAgentRuns`，定义读取 Session 固定 revision 中的规范正文。运行、人工响应和取消复用控制台原生入口及执行详情。

来源回收限定为编辑器创建的不可变 ConfigMap：每个定义保留最近 10 份来源，其他来源在最后使用 24 小时后进入回收检查。检查覆盖工作空间内原生资源及工作流提示词引用；重新使用历史来源时通过 CAS 更新最后使用时间，删除使用 UID 和 `resourceVersion` 前置条件。

## 权限与分层

管理写入使用 `AGENTS_MANAGE`，Agent 和 AgentTemplate 请求传递调用者凭据。服务账号在工作空间内管理正文资源；工具绑定经过既有 AccessPlan 决策规范化，模板保存沿用 Preset 用户接管规则。`hitl` 使用原生人工问答；需要工具确认的动作委派给具备对应审批绑定的 Agent。

| 定义 | 所有者 |
| --- | --- |
| Agent 模型、工具、子 Agent 路由与并行 | kagent AgentSystem |
| 调度、批次认领、整体时限、恢复和兜底 | Temporal / 业务服务 |
| 业务审批、变更授权与恢复验证 | 工单 / 变更服务 |
| 团队协作与业务全景展示 | Pack.workflows |

Temporal 业务流程由业务服务 SDK 代码及版本管理交付，执行参数由所属领域 API 管理。Agent 子流程与业务全景分别读取各自的权威定义。

协议和实现入口见[代码导航](code-navigation.md)。
