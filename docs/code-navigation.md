# 代码导航

## 协议与生成

| 路径 | 内容 |
| --- | --- |
| `proto/agentos/{console,management}/v1` | 控制台、资源管理、知识与方案展示 RPC |
| `proto/agentos/authorization/v1` | 原生主体的 UI 能力投影 |
| `proto/agentos/execution/v1` | 原生执行的 UI 状态与工具视图 |
| `proto/agentos/{governance,mcp,voice}/v1` | 环境声明、MCP App 引用与语音接口 |
| `third_party` | 固定版本原生 proto、CRD schema 与许可证 |
| `contracts` | Buf、schema / CRD 类型生成与契约包配置 |

## 服务与控制器

依赖自上而下，`server/shared` 与 `shared` 位于最底层；分层规则由 [biome.layers.json](../biome.layers.json) 在 `npm run check` 中校验。

| 层 | 路径 | 内容 |
| --- | --- | --- |
| 入口 | `server/apps` | api、可选遥测与工作空间组合根 |
| 业务 | `server/voice`、`voice/agentos_voice` | 可选语音会话与 LiveKit worker |
| 业务 | `server/management` | 原生资源 CRUD、模型 / MCP 连接与运行配置 |
| 业务 | `server/management/workflows` | 原生工作流目录、候选校验、不可变发布、布局和来源回收 |
| 业务 | `server/console` | 控制台 RPC、原生发送 / HITL / 取消、定时任务、会话订阅与角色管理 |
| 业务 | `server/mcp-apps` | 原生归属校验、视图投影与查看者工具回调 |
| 平台 | `server/platform` | 工作空间目标、逐请求准入与服务分发 |
| 投影 | `server/read-model` | 原生分页、可信执行树投影、历史与订阅 |
| 投影 | `server/authorization` | 原生身份投影、资源授权 RPC、应用能力与委托授权入口 |
| 基础 | `server/kagent` | 原生客户端、请求凭据、资源信封、角色模板映射与编译准入 |
| 基础 | `server/governance` | AccessPlan Informer 与已编译工具决策 |
| 基础 | `server/shared` | 配置、错误、分页、Kubernetes 错误映射与遥测 |

| 路径 | 内容 |
| --- | --- |
| `controller/api`、`controller/config/crd/bases` | AccessPlan / Preset 类型与 CRD |
| `controller/internal/{compile,reconcile}` | 原生资源编译、SSA 与所有权收敛 |
| `controller/internal/{connections,speech}` | kagent agentgateway 模块与语音接线 |
| `controller/internal/{render,scheme}` | 离线渲染校验与共用 Scheme |

## 控制台与交付

| 路径 | 内容 |
| --- | --- |
| `src/{app,components,features}` | 控制台、聊天、Agent 团队与管理页 |
| `src/lib/workspace-*` | 工作空间路由、成员目录与浏览器切换 |
| `src/features/workflows` | 独立工作流入口、AgentSystem 画布 / YAML 编辑、发布状态与执行历史 |
| `src/features/agents` | 通用 Agent 目录、模板编辑、模型与运行时选择、工具绑定与方案业务全景 |
| `src/features/chat` | 聊天、MCP App 宿主、听写、朗读与语音通话 |
| `src/features/tasks` | 任务历史与只读执行记录 |
| `src/features/schedules` | 定时任务、方案推荐模板与执行记录 |
| `src/features/authorization` | 原生角色目录、按账号 / 组汇总的角色标签与资源直接授权管理 |
| `src/features/shared` | 跨功能的资源列表、对话框、运行时选择器、审批与工具展示 |
| `src/{lib,i18n}` | RPC、连接状态与展示文案 |
| `shared` | 浏览器与服务端共用的 JSON、权限、模型用途与原生标识 |
| `web` | nginx、oauth2-proxy 与 MCP App 沙箱 |
| `charts/agentos*` | 平台、控制器、环境网关与连接 Chart |
| `deploy` | 参考部署 Ansible collection `agentos.platform`：节点、运行时、平台应用与环境接入剧本 |
| `.github`、`ci` | 检查、镜像、契约、Chart 与 collection 发布 |
| `tests` | 平台边界回归、原生客户端替身与真实组件验证 |

校验入口为 `npm run verify`、`ci/check-charts.sh`、`ci/check-collection.sh`、`ci/contracts.py` 和 `go -C controller test -race ./...`。
