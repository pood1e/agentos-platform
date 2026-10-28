# 代码导航

| 路径 | 内容 |
| --- | --- |
| `controller/api/v1alpha1` | AccessPlan / Preset Go 类型及生成的 DeepCopy |
| `controller/internal/compile` | 工具分级、原生资源与预置绑定的纯编译器 |
| `controller/internal/reconcile` | SSA、所有权、连接条件与中断恢复 |
| `controller/cmd/{controller,render}` | 控制器与离线展开验证 |
| `proto/agentos/execution/v1` | 执行引用与请求、通用执行状态、任务运行与工具调用 |
| `server/execution` | 外部执行 MCP、来源主体与分页结果 |
| `proto/agentos/console/v1` | 控制台 RPC：会话、任务、角色、工具、方案包展示（`pack.proto`） |
| `proto/agentos/management/v1` | 管理 RPC：连接、模型、Harness、Skill、知识 |
| `proto/agentos/governance/v1` | 环境、可选外部审批协议 |
| `proto/agentos/kagent/v1` | kagent 线上格式的补充定义 |
| `server/apps` | 进程入口：api、dataplane、worker、identity，共享引导与 OpenTelemetry SDK |
| `server/console` | 控制台服务：Connect RPC、方案包加载与资源、角色模板读写 |
| `server/jobs` | pg-boss 作业队列：协调作业的入队与消费、死信重放 |
| `server/read-model` | kagent 任务的 PostgreSQL 投影：紧凑记录、执行树、写时摘要与 SQL 列表，水位对账、跨副本命令锁与查看时的 A2A 订阅 |
| `server/read-model/graph.ts`、`server/console/watch.ts` | 单棵执行树的委派关系，按执行树唤醒的订阅、心跳和健康检查 |
| `server/authorization` | Bearer 令牌校验、离线委派端点、执行身份绑定、凭证持久化、Actor 验证与运行时授权 |
| `server/kagent` | kagent 官方客户端、Harness 与内置工具 |
| `server/kagent/configuration.ts` | 官方 Kubernetes Informer 配置索引与运行时授权读取 |
| `server/mcp-apps` | MCP Apps 元数据投影、资源缓存与当前用户的只读工具回调 |
| `server/identity` | 密码模式的内置身份源：oidc-provider 配置、站点密码登录与限速、PostgreSQL 存储 |
| `server/shared` | 服务端公共配置、错误、健康检查、咨询锁选主与 RPC 指标 |
| `server/management` | 管理页后端：kagent 与 agentgateway 原生资源的读写 |
| `server/management/connections.ts` | 原生父对象与凭据保存；编译结果的管理页投影 |
| `server/knowledge` | 团队知识检索 |
| `server/voice` | 可选语音：设置 Secret、语音会话签发与 voice worker 的 `VoiceService` |
| `voice/agentos_voice` | LiveKit Agents worker：听写、朗读与通话，AgentOS 对话作为通话的 LLM |
| `shared/browser` | 对外发布的 LiveKit 听写、朗读、通话适配器与官方 MCP AppBridge 生命周期封装 |
| `server/team-sessions` | 协作 MCP：发现 Agent、创建与续接会话、知识检索、角色起草 |
| `server/governance` | AccessPlan Informer、已编译工具授权、原生暂停与外部审批协调 |
| `shared/` | 前后端共用模型 |
| `server/Dockerfile`、`server/tsconfig.json` | 平台服务镜像与编译配置 |
| `src/app`、`src/components` | 前端路由、布局与 shadcn/ui 组件 |
| `src/features` | 聊天、任务、团队、管理、状态等页面 |
| `src/features/chat` | assistant-ui 会话、流式文本、会话历史与删除、紧凑工具图标、工作 Agent 与子 Agent 结果 |
| `src/features/chat/apps` | MCP Apps 折叠卡片、资源查询与重试、共享宿主接线和主题上下文 |
| `src/features/shared` | 头像、工具图标、原生确认与外部审批等公共展示 |
| `src/features/tasks` | 任务标签、停止操作、任务定位与原生执行记录 |
| `src/lib` | RPC 客户端、方案包展示（`pack.ts`）与通用工具 |
| `src/i18n` | 平台通用文案 |
| `web` | web 镜像：前端产物与 MCP App 沙箱页的 nginx 配置 |
| `charts/agentos` | 平台 Chart：api、dataplane、worker、web、密码模式身份源、HTTPRoute、平台网关资源、嵌入模型、Harness、Skill 目录与系统 Agent |
| `tests` | 单元与集成测试；`tests/fake-kagent` 是录制驱动的 kagent 替身 |
| `tests/fixtures/pack` | 示例方案包，供测试使用 |
| `tests/fixtures/solution-chart` | 依赖平台 Chart 的示例方案 Chart，供 Chart 校验使用 |
| `runtime` | kagent、Agent Substrate 的固定版本补丁与 Harness 工具箱镜像 |
| `contracts` | 协议生成模板、模型生成脚本、Python wheel 与 Node SDK 的打包配置；SDK 同时发布官方依赖的 proto 源码 |
| `mise.toml`、`mise.lock` | 开发与 CI 共用的工具版本、平台来源与完整性锁定 |
| `charts/agentos-controller` | 控制器部署与 Preset 的共享 Helm library |
| `controller/config/crd/bases` | 平台与环境 Chart 共用的 CRD |
| `contracts/generate-kubernetes.mjs` | 从 CRD 生成 Helm schema、TS 类型与编译器测试夹具 |
| `.github` | 合并前检查、release-please 配置、自动发布 PR 与正式 tag |
| `ci` | GitLab CI 作业、镜像构建、Chart 校验与发布脚本 |
| `deploy` | Ansible playbook 与角色、collection 源码、OCI 验签、运行时 Helm 值与 Kustomize overlays |
| `environments` | 环境套件：环境网关、连接器后端、身份映射与平台接入 |
| `charts/agentos-environment`、`charts/agentos-connections` | 环境网关与平台接入的独立 Helm release、原生 Chart 测试 |
| `third_party` | 上游协议、CRD 与组件来源 |

| 扩展路径 | 职责 |
| --- | --- |
| `server/platform` | dataplane 的网关授权接线、协作 MCP 与 gRPC 排空，api 的访问上下文与环境 API 中转 |

| 校验入口 | 内容 |
| --- | --- |
| `ci/check-charts.sh` | 平台、方案示例与环境 Chart 的统一校验入口 |
| `charts/*/tests` | helm-unittest 模板、非法配置与资源生命周期用例 |
| `tests/policies` | Conftest 跨资源、工具绑定、工作负载及原生部署约束 |
| `tests/deployment` | 后置渲染器的标准库单元测试 |
| `ci/test-artifacts.py` | 临时 OCI 注册表中的签名、篡改、版本与提交验证 |
