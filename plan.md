# AgentOS 控制台改进计划

## Context

对照 agno AgentOS 控制平面（os.agno.com）与本仓库控制台（main `137bf3c`，fake kagent 逐页核对）：

- **已具备且领先**：跨会话的委派协作图（会话实例级 DAG、审批工单节点）、聊天内联变更方案与工具参数、Harness 切换、方案包品牌（`pack.json`）、测评候选的配置差异与逐例分数。
- **缺失**：运行中取消；任务按状态/成员筛选；跨任务的待审批入口；运行时间线；用量与运营概览；会话重命名/删除；知识文件导入；配置版本历史；定时任务；案例反馈与运营指标。
- agno 对应能力：Chat（取消/续接/分叉）、Sessions、Traces（树与瀑布）、Metrics、Approvals 队列、Knowledge 导入、Studio 版本、Scheduler。

## 已确认决策

| 项 | 决策 |
| --- | --- |
| 数据源 | 运行、委派、审批与工具调用只取 kagent 原生 A2A 读模型；模型 span、Token 与成本取 Langfuse，不在平台另建追踪存储 |
| 审批 | 默认使用原生工具确认；业务方可通过 ApprovalService 接入外部决定、执行准备与结果回写 |
| 取消 | 取消操作树中所有未结束的前台任务，复用案例自动化的取消逻辑；已执行的副作用仍需核验 |
| 不跟进 | 按用户的记忆、多运行时切换、人员与角色管理（控制台已决定开放访问） |

## 首批实施前的基线

- `ListTasks` 只有文字 `query`；任务状态由 `treeState` 计算，含 `AWAITING_APPROVAL`。分页游标绑定 `scope` 与 `query`。
- `TaskRun` 只有 `updated_at`，读模型 `TaskEntry.createdAt` 已有开始时间但未输出。
- 取消逻辑在 `server/platform/automation.ts` 的 `cancel_case`：遍历 `foreground(tree)`，对未结束任务调用 `a2a.cancelTask`。
- 审批记录经 `approvalReferences` 按交互补齐（`ListApprovals`）；任务页点击状态可打开审批抽屉。
- 测评候选页已有逐例、逐规则的候选/已发布分数与实验链接；缺规则汇总、退化判定、单例错误与 trace 链接。
- kagent `SessionService` 有 `UpdateSessionName`、`DeleteSession`；fake kagent 未实现 `CancelTask`、`UpdateSessionName`、`DeleteSession`。
- Collector 保留 `kagent.session.id`、`kagent.task.id`、`gen_ai.conversation.id`，Langfuse 会话映射未核实。

## 第一批（本分支）

- [x] **任务筛选**：`ListTasksRequest` 增加 `states`、`engineer`；游标绑定筛选条件；任务列表增加状态与成员筛选。
- [x] **待审批入口**：顶栏显示待审批数（`ListTasks` 按 `AWAITING_APPROVAL` 计数），点击进入已筛选的任务列表并打开审批抽屉。
- [x] **取消**：新增 `CancelTask`；取消逻辑抽为读模型公共函数，案例自动化与控制台共用；任务页与聊天提供停止入口；fake kagent 实现 `CancelTask`。
- [x] **时间线**：`TaskRun` 增加 `started_at`；任务详情在协作图与时间线间切换，按成员显示执行区间、委派与审批区间，点击打开执行抽屉。
- [x] **测评详情**：候选结果增加规则汇总（候选/已发布均值、差值、门槛、判定）、单例错误与 Langfuse trace 链接。

验收：`npm run verify`（新增读模型筛选、取消与时间线数据的单元测试）、Playwright（筛选、待审批跳转、取消、时间线、测评汇总）、Chart 与环境校验、GitLab 流水线通过。

已验证：含 PostgreSQL 的 246 项 TypeScript 测试、48 项 Playwright 测试、27 项 Python 测试、Ansible lint 与语法检查、Chart 和环境清单严格校验。
取消回归覆盖已结束的调用者、等待审批的子任务、自动续接、后台任务隔离、部分失败与结束竞态。UI 复用 shadcn/ui，时间线使用 vis-timeline。

## 第二批

- **Langfuse 深链**：核实或在 Collector 中把 `kagent.session.id` 映射为 Langfuse 会话；控制台配置 Langfuse 地址与项目，执行抽屉链接到对应会话。
- **运营与用量概览**：读模型汇总任务数、成功率、审批数、耗时与成员工具调用，按天趋势；Token 与成本取 Langfuse 指标 API。
- **会话管理**：重命名（`UpdateSessionName`）；删除仅限无审批与写调用的会话，保留审计。
- **知识导入**：上传文本类文件写入团队知识；URL 导入暂不做。
- **配置版本**：工程师配置的版本历史与回滚，基于测评候选快照。

## 第三批

- **定时任务**：Temporal Schedule 驱动案例自动化，控制台管理计划、启停、手动触发与运行历史。
- **案例与反馈**：接入案例自动化的 `/feedback`、`/metrics`，提供案例列表、结论反馈与运营指标。
- [x] **指定 Agent 对话**：会话显式选择工作空间 Agent，默认入口由 `entryAgent` 配置。

## 平台边界重构

- [x] 平台仅定义执行、会话、工具确认与可选外部审批契约。
- [x] AIOps 变更方案、Zammad 审批、计划工具和执行守卫迁入 aiops-mvp。
- [x] 通用执行不依赖唯一协调者，案例触发显式选择 Agent。
- [x] 控制台参考 Agno 的能力导航，复用 shadcn/ui、assistant-ui、React Flow 与 vis-timeline。
