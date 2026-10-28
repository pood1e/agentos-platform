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

| 路径 | 内容 |
| --- | --- |
| `server/apps` | api、dataplane 与可选遥测入口 |
| `server/kagent` | 原生客户端、请求凭据上下文、编译准入 |
| `server/authorization` | 原生身份投影、应用能力、委托授权入口与业务 MCP 发现认证 |
| `server/console` | 控制台 RPC、原生发送 / HITL / 取消与角色管理 |
| `server/read-model` | 原生分页、可信执行树投影、历史与订阅 |
| `server/management` | 原生资源 CRUD、模型 / MCP 连接与运行配置 |
| `server/knowledge` | 原生团队 MemoryService 客户端 |
| `server/governance` | AccessPlan Informer 与已编译工具决策 |
| `server/team-sessions` | 角色工具目录与起草 MCP |
| `server/mcp-apps` | 原生归属校验、视图投影与查看者工具回调 |
| `server/voice`、`voice/agentos_voice` | 可选语音会话与 LiveKit worker |
| `controller/api`、`controller/config/crd/bases` | AccessPlan / Preset 类型与 CRD |
| `controller/internal/{compile,reconcile}` | 原生资源编译、SSA 与所有权收敛 |
| `controller/internal/{connections,speech}` | kagent agentgateway 模块与语音接线 |

## 控制台与交付

| 路径 | 内容 |
| --- | --- |
| `src/{app,components,features}` | 控制台、聊天、Agent 团队与管理页 |
| `src/{lib,i18n}`、`shared` | RPC、展示文案与平台内部共享代码 |
| `web` | nginx、oauth2-proxy 与 MCP App 沙箱 |
| `charts/agentos*` | 平台、控制器、环境网关与连接 Chart |
| `.github`、`ci` | 检查、镜像、契约与 Chart 发布 |
| `tests` | 平台边界回归、原生客户端替身与真实组件验证 |

校验入口为 `npm run verify`、`ci/check-charts.sh`、`ci/contracts.py` 和 `go -C controller test -race ./...`。站点安装与签名 collection 见 [agentos-deploy](https://github.com/pood1e/agentos-deploy)。
