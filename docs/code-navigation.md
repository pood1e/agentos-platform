# 代码导航

## 协议与生成

| 路径 | 内容 |
| --- | --- |
| `proto/agentos/console/v1` | 控制台 RPC、会话、任务、角色与方案展示 |
| `proto/agentos/management/v1` | 连接、模型、Harness、Skill 与知识管理 |
| `proto/agentos/execution/v1` | 外部执行、执行身份、任务与工具调用视图 |
| `proto/agentos/governance/v1` | 环境、工具确认模式与环境服务连接 |
| `proto/agentos/mcp/v1` | MCP App 视图引用 |
| `third_party` | 上游 proto、CRD schema、许可证与版本来源 |
| `contracts` | Buf 生成配置、CRD / 管理表单生成、Node SDK 与 Python wheel 打包 |

## 平台服务

| 路径 | 内容 |
| --- | --- |
| `server/apps` | api、dataplane、worker、identity 入口与可选遥测初始化 |
| `server/console` | 控制台 RPC、原生 HITL 回复、方案包与角色管理 |
| `server/authorization` | 用户与工作负载认证、离线委派、执行绑定、凭据和逐调用授权 |
| `server/execution` | 可选外部执行 MCP、来源身份与分页结果 |
| `server/governance` | 环境配置、AccessPlan Informer 与已编译工具决策 |
| `server/kagent` | 原生客户端、配置索引、Harness 与工具元数据 |
| `server/management`、`server/knowledge` | 原生资源管理与团队知识检索 |
| `server/read-model` | PostgreSQL 读投影、执行树、归属过滤、分页、对账与订阅 |
| `server/team-sessions` | 协作 MCP、角色起草与委派结果续接 |
| `server/jobs` | 续接队列、消费与死信重放 |
| `server/mcp-apps` | 模板读取、视图投影与当前查看者的工具回调 |
| `server/platform` | 网关与 MCP 接线、gRPC 生命周期、访问上下文和环境 API 中转 |
| `server/identity` | 内置密码身份源 |
| `server/voice`、`voice/agentos_voice` | 可选语音会话与 LiveKit worker |
| `server/shared`、`shared` | 服务端基础设施与前后端共享代码 |

## 控制台、资源与交付

| 路径 | 内容 |
| --- | --- |
| `src/app`、`src/components` | 路由、布局与通用组件 |
| `src/features` | 聊天、执行记录、Agent 团队和管理页面；`chat/apps` 为 MCP Apps 宿主接线 |
| `src/lib`、`src/i18n` | RPC 客户端、方案展示与平台文案 |
| `shared/browser` | 对外发布的语音适配器与 MCP AppBridge 封装 |
| `web` | nginx、oauth2-proxy 与沙箱页配置 |
| `controller/api`、`controller/config/crd/bases` | AccessPlan / Preset 类型与 CRD |
| `controller/internal/compile`、`controller/internal/reconcile` | 资源编译、SSA、所有权与状态收敛 |
| `charts/agentos`、`charts/agentos-controller` | 平台应用与共享控制器 library Chart |
| `charts/agentos-environment`、`charts/agentos-connections` | 环境网关与平台连接 release |
| `runtime` | kagent fork 构建、Substrate 启动修复与 Harness 基础镜像 |
| `deploy`、`environments` | Ansible collection、运行时部署、站点接入与资源生命周期 |
| `.github`、`ci` | 合并检查、构建、验签、版本与发布 |
| `mise.toml`、`mise.lock` | 开发与 CI 工具版本及来源锁定 |
| `tests` | 单元与集成回归；`fake-kagent` 为录制驱动替身，`proofs` 为真实组件验证 |
| `tests/fixtures/solution-chart`、`tests/fixtures/pack` | 扩展契约的方案示例 |

常用校验入口为 `npm run verify`、`ci/check-charts.sh` 与 `ci/test-artifacts.py`；控制器验证见 [Kubernetes 控制器](kubernetes-controller.md#验证)。
