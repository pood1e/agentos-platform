# 代码导航

| 路径 | 内容 |
| --- | --- |
| `proto/agentos/distribution/v1` | 发布清单：源提交、版本与制品摘要 |
| `proto/agentos/execution/v1` | 通用执行状态、任务运行与工具调用 |
| `proto/agentos/console/v1` | 控制台 RPC：会话、任务、角色、工具、方案包展示（`pack.proto`） |
| `proto/agentos/management/v1` | 管理 RPC：连接、模型、Harness、Skill、知识 |
| `proto/agentos/governance/v1` | 环境、可选外部审批协议 |
| `proto/agentos/automation/v1` | 自动化 RPC、方案预置、案例 MCP 入参、worker 配置与案例事实；定时任务复用 kagent 官方协议 |
| `proto/agentos/kagent/v1` | kagent 线上格式的补充定义 |
| `server/console` | 控制台服务：Connect RPC、静态资源、方案包加载、角色模板读写 |
| `server/jobs` | pg-boss 协调队列、消费注册与死信重放 |
| `server/read-model` | kagent 任务与事件的读模型：会话、操作树、调用与交互 |
| `server/read-model/observation.ts`、`server/console/watch.ts` | 会话与操作树的变更筛选、订阅心跳和健康检查 |
| `server/authorization` | 执行身份绑定、凭证持久化、Actor 验证与运行时授权 |
| `server/automation` | 原生定时任务的工作空间授权、方案预置与只读执行身份绑定 |
| `server/kagent` | kagent 官方客户端、Harness 与内置工具 |
| `server/kagent/configuration.ts` | 官方 Kubernetes Informer 配置索引与运行时授权读取 |
| `server/mcp-apps` | MCP Apps 元数据投影、资源缓存、当前用户的只读工具回调与独立源沙箱代理 |
| `server/management` | 管理页后端：kagent 与 agentgateway 原生资源的读写 |
| `server/management/changes.ts` | 连接更新的原生预检与版本约束回滚 |
| `server/knowledge` | 团队知识检索 |
| `server/speech`、`src/features/chat/speech` | 语音设置 Secret、音频 API 适配与 assistant-ui 听写、朗读 |
| `shared/browser` | 对外发布的听写、流式朗读、LiveKit 通话适配器与官方 MCP AppBridge 生命周期封装 |
| `server/team-sessions` | 协作 MCP：发现 Agent、创建与续接会话、知识检索、角色起草 |
| `server/governance` | 工具分级与身份绑定、原生暂停与外部审批协议的协调 |
| `server/shared`、`shared/` | 服务端公共配置、错误与前后端共用模型 |
| `src/app`、`src/components` | 前端路由、布局与 shadcn/ui 组件 |
| `src/features` | 聊天、任务、团队、管理、状态等页面 |
| `src/features/chat` | assistant-ui 会话、流式文本、会话历史与删除、紧凑工具图标、工作 Agent 与子 Agent 结果 |
| `src/features/chat/apps` | MCP Apps 折叠卡片、资源查询与重试、共享宿主接线和主题上下文 |
| `src/features/shared` | 头像、工具图标、原生确认与外部审批等公共展示 |
| `src/features/tasks` | 任务标签、停止操作与任务定位 |
| `src/features/system-tasks` | 管理员共享的系统任务页面：定时任务管理、运行历史、只读执行会话和环境事件入口 |
| `src/lib` | RPC 客户端、方案包展示（`pack.ts`）与通用工具 |
| `src/i18n` | 平台通用文案 |
| `charts/agentos` | 平台 Chart：单一 API、平台网关资源、嵌入模型、Harness、Skill 目录与系统 Agent |
| `tests` | 单元与集成测试；`tests/fake-kagent` 是录制驱动的 kagent 替身 |
| `tests/fixtures/pack` | 示例方案包，供测试使用 |
| `tests/fixtures/solution-chart` | 依赖平台 Chart 的示例方案 Chart，供 Chart 校验使用 |
| `runtime` | kagent、Agent Substrate 的固定版本补丁与 Harness 工具箱镜像 |
| `contracts` | Python wheel 与 Node SDK 的打包配置，SDK 同时发布官方依赖的 proto 源码 |
| `mise.toml`、`mise.lock` | 开发与 CI 共用的工具版本、平台来源与完整性锁定 |
| `.github/workflows` | 合并前检查、自动发布 PR 与正式 tag |
| `ci` | GitLab CI 作业、镜像构建、Chart 校验与发布脚本 |
| `deploy` | 单节点参考部署的 Ansible 剧本、运行时 Helm 值与 post-renderer |
| `environments` | 环境套件：环境网关、连接器后端、身份映射与平台接入 |
| `charts/agentos-environment`、`charts/agentos-connections` | 环境网关与平台接入的独立 Helm release、原生 Chart 测试 |
| `third_party` | 上游协议、CRD 与组件来源 |

| 扩展路径 | 职责 |
| --- | --- |
| `server/platform` | 进程入口、工作负载接线与协作边界 |
| `automation` | 案例自动化 worker（Python）：JetStream 消费、Temporal 案例工作流、人工反馈入口 |

| 校验入口 | 内容 |
| --- | --- |
| `ci/check-charts.sh` | 平台、方案示例与环境 Chart 的统一校验入口 |
| `charts/*/tests` | helm-unittest 模板、非法配置与资源生命周期用例 |
| `tests/policies` | Conftest 跨资源、工具绑定、工作负载及原生部署约束 |
| `tests/deployment` | 后置渲染器的标准库单元测试 |
