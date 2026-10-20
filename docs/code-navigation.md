# 代码导航

| 路径 | 内容 |
| --- | --- |
| `proto/agentos/console/v1` | 控制台 RPC：会话、任务、角色、工具、方案包展示（`pack.proto`） |
| `proto/agentos/management/v1` | 管理 RPC：连接、模型、Harness、Skill、知识 |
| `proto/agentos/governance/v1` | 环境、连接与变更方案 |
| `proto/agentos/evaluation/v1` | 测评：候选、基线、执行与回报，内置评分器读取的 `Expectation` |
| `proto/agentos/automation/v1` | 案例自动化：案例 MCP 入参、worker 配置、方案包的 `CaseTrigger` 与案例事实 |
| `proto/agentos/kagent/v1` | kagent 线上格式的补充定义 |
| `server/console` | 控制台服务：Connect RPC、静态资源、方案包加载、角色模板读写 |
| `server/read-model` | kagent 任务与事件的读模型：会话、调用、交互、协作画布 |
| `server/kagent` | kagent 官方客户端、Harness 与内置工具 |
| `server/management` | 管理页后端：kagent 与 agentgateway 原生资源的读写 |
| `server/knowledge` | 团队知识检索 |
| `server/team-sessions` | 协作 MCP：委派协调者、续接会话、知识检索、角色起草 |
| `server/operations` | 工具分级、身份绑定，以及原生暂停与环境审批之间的协调 |
| `server/change-control` | 环境侧变更控制：方案登记、ExtMCP 守卫、审批提供方接口与 Zammad 实现 |
| `server/shared`、`shared/` | 服务端公共配置、错误与前后端共用模型 |
| `src/app`、`src/components` | 前端路由、布局与 shadcn/ui 组件 |
| `src/features` | 聊天、任务、团队、管理、状态等页面 |
| `src/features/shared` | 头像、工具图标、审批与变更单等公共展示 |
| `src/lib` | RPC 客户端、方案包展示（`pack.ts`）与通用工具 |
| `src/i18n` | 平台通用文案 |
| `charts/agentos` | 平台 Chart：单一 API、平台网关资源、嵌入模型、Harness、Skill 目录与系统 Agent |
| `tests` | 单元与集成测试；`tests/fake-kagent` 是录制驱动的 kagent 替身，`tests/e2e` 是浏览器测试 |
| `tests/fixtures/pack` | 示例方案包，供测试使用 |
| `tests/fixtures/solution-chart` | 依赖平台 Chart 的示例方案 Chart，供 Chart 校验使用 |
| `runtime` | kagent、Agent Substrate 的固定版本补丁与 Harness 工具箱镜像 |
| `ci` | GitLab CI 作业、镜像构建、Chart 校验与发布脚本 |
| `deploy` | 单节点参考部署的 Ansible 剧本、运行时 Helm 值与 post-renderer |
| `environments` | 环境套件：环境网关、连接器后端、change-control、Zammad 审批引导与平台接入 |
| `tests/fixtures/environments` | 环境套件的示例清单与变量，供渲染校验使用 |
| `third_party` | 上游协议、CRD 与组件来源 |

| 扩展路径 | 职责 |
| --- | --- |
| `server/platform` | 进程入口、人类身份验证、机器权限与协作边界 |
| `server/evaluation` | 候选快照、隔离运行、Job 与发布门禁 |
| `evaluation` | 测评作业与 SDK（Python）：Langfuse 实验、评分器注册表与内置评分器、数据集冻结 |
| `automation` | 案例自动化 worker（Python）：JetStream 消费、Temporal 案例工作流、反馈与测评回报入口 |
| `deploy/observability` | 官方 Langfuse、Collector 与独立存储 |
