# 扩展契约

平台定义通用契约、加载与校验，方案包提供资源、展示内容及业务服务。方案包通常是一个依赖平台 Chart 的业务 Chart，
加上一个展示镜像与环境侧的连接器。

| 扩展点 | 形式 | 平台提供 | 方案包提供 |
| --- | --- | --- | --- |
| 团队 | Preset 内的原生 `AgentTemplate` 与 `Agent` | 未修改预置随升级更新，用户编辑后保留 | 业务角色、提示词、工具绑定、Harness 选择 |
| 角色标识 | `Agent` 的 `agentos.dev/role` 标签与显示注解 | 保留角色键、解析与展示 | 业务角色键、显示名、说明 |
| Skill | `global.agentos.skills`，kagent 原生来源 | 共享目录、保存前 dry-run 校验、只读 Git 网关 | Skill 内容与固定版本 |
| 工具分级 | `global.agentos.toolsets` → AccessPlan | 统一编译环境网关视图与原生暂停绑定，未知工具拒绝 | 各连接器的分级及与原生 MCP 注解的一致性检查 |
| 身份档案 | `global.agentos.identities` | 生成各角色的 RemoteMCPServer 绑定与环境侧账号清单 | 各角色的环境范围与访问级别 |
| 环境接入 | `global.agentos.environments` 与 `EnvironmentConnection`（proto） | 审批协调、OIDC 资源令牌、TLS 信任和凭据绑定 | 环境标识、治理模式、issuer 与 resource |
| 连接器 | 环境内的 MCP 服务与 `environment_connectors` 后端描述 | 环境网关、身份映射、读写视图 | MCP 服务、目标系统与各身份的后端凭据 |
| 对话视图 | MCP Apps 官方扩展 `io.modelcontextprotocol/ui` | 独立源沙箱、宿主桥接、按当前用户授权的只读工具回调 | MCP 工具的 `_meta.ui`、`ui://` 单文件 HTML 与取数工具 |
| 审批提供方 | proto `ApprovalService`，Connect RPC | 原生确认与外部决定协调 | 业务审批、方案、执行守卫与结果回写 |
| 模型 | agentgateway 原生 `AgentgatewayModel` | 管理页与 `ModelConfig` 同步 | 上游地址、协议与密钥 |
| 语音 | `speech`（proto `SpeechConfiguration`） | 可选 ASR/TTS 接入、能力查询与聊天控件 | 站点提供模型服务、音色及凭据 |
| 展示 | `pack.json` 与资源文件（proto `Pack`） | 平台通用文案、通用头像与工具图标 | 标题、角色头像、工具图标与业务文案 |

## 对话视图

工具通过 `_meta.ui.resourceUri` 关联 MIME 为 `text/html;profile=mcp-app` 的资源；取数工具可声明 `visibility: ["app"]`，
同样列入方案包的 `toolsets.readOnly`。目录路由提供视图元数据与模板，Agent 路由保留可见性并移除资源 URI，分析结果继续进入模型。

卡片默认折叠，展开后加载 View。宿主使用当前查看者凭证，经原调用 Agent 的环境身份调用同一服务的只读工具；
回调范围限定为同服务、含 `app` 可见性的只读工具。`ui/message` 只预填聊天输入框；链接限 `http(s)`。

站点在平台 Chart 配置 `route.hosts.sandbox`，并在站点 Gateway 上准备对应 DNS 与证书。
View 使用规范默认 CSP，可显式申请 `data:` 静态资源，数据访问经宿主工具回调。接入与验证见[对话视图](mcp-app.md)。

## 外部执行

外部调度器、事件服务和持久化工作流通过 `/mcp/executions` 调用普通 Agent 执行。站点在 `execution.sources` 登记 OIDC client credentials 身份及允许启动的 Agent；列表为空时部署不创建该入口。

```yaml
execution:
  sources:
    - issuer: https://identity.example.com/realms/operations
      audience: agentos-executions
      clientId: analysis-controller
      subject: <service-account-user-id>
      agents: [{namespace: agentos, name: diagnosis}]
```

- `run_execution` 接受 `agentos.execution.v1.RunExecutionRequest`：调用方生成请求 UUID，指定授权 Agent 与消息。相同请求的重试复用原生会话和 messageId，输入保持一致。
- `get_execution` 接受执行引用及分页参数，读取本调用方的原始任务和因果子任务。结果脱敏、分页并限制响应大小，查询不创建会话。
- `cancel_execution` 撤销执行授权并取消未结束的委派任务。尚未确认接收的请求也可取消，后续重试仍受撤销状态约束。

平台校验签名、issuer、audience、`azp`、`sub` 与目标 Agent；后台调用重新读取来源授权，并保留执行树初始权限上限。业务服务管理触发条件、频率、截止时间与业务结果，调度及工作流后端独立交付。

## 环境 API

`EnvironmentConnection.apis` 声明环境服务的 `service`、`readMethods` 和 `writeMethods`。平台 `/environments/{environment}/rpc/{service}/{method}` 只转发白名单中的 unary Connect JSON，按当前用户进行环境令牌交换，保留环境服务的原生错误。写方法要求用户写权限，读写名单互斥。环境服务继续负责资源、业务角色和审批校验。

## 模型用途

模型接入通过 `AgentgatewayModel` 的 `agentos.dev/model-purpose` 注解区分 `language` 与 `embedding`，未声明时为对话模型。用途随接入同步到原生 `ModelConfig`；模型页面按用途查询、分页和展示，向量模型用于知识记忆，对话模型用于聊天 Harness。

## 任务标签

`pack.json` 的 `taskTags` 提供可选标签建议，例如 `["rca", "auto-remediation"]`；标签仍可由用户自定义。`locales.<language>.translation.task.tagNames` 提供显示名称，缺失时显示原始值。每个任务最多 32 个标签，每个标签最多 40 个字符。预置建议由方案包维护，标签编辑、可见范围与筛选由平台负责。

## 角色标识

角色键写在 `Agent` 的 `agentos.dev/role` 标签上，用于文案、头像与身份档案。平台保留以下角色键，其余由方案包定义：

| 角色键 | 含义 |
| --- | --- |
| `assistant` | 默认聊天入口，由平台 Chart 管理；可通过 `entryAgent` 选择其他入口 |
| `role-builder` | 角色构建，由平台 Chart 管理 |

角色键用于展示与身份档案，执行拓扑取自原生 task 和 session。默认任务按原生 task 分组；需要把多轮执行展示为一个任务的 Agent 设置注解 `agentos.dev/task-scope: session`。

注解 `agentos.dev/display-name` 与 `agentos.dev/description` 是用户在控制台修改的显示名与说明，优先于方案包文案。

## Chart 入参

方案包 Chart 依赖平台 Chart，以 Helm 全局值 `global.agentos` 提供团队配置，平台 Chart 与环境套件读取同一份值：

```yaml
global:
  agentos:
    environments:
      - {name: <environment>, governance: approval}   # approval：写调用逐次审批；direct：按原生身份权限直接执行
    toolsets:
      <service>:                                      # 连接器 MCP 服务
        readOnly: [<tool>, ...]
        write: [<tool>, ...]
        approval: [<tool>, ...]                       # 可选，需确认的写调用；省略时为 write 与 management
        managementReadOnly: [<tool>, ...]             # 仅 manage 级别可见
        management: [<tool>, ...]                     # 仅 manage 级别可见
    identities:
      - name: <role>
        environments: [<environment>, ...]            # 省略时为全部环境
        services: {<service>: read}                   # read | operate | manage
    skills:
      - skill: {name: <skill>, git: {commit: <sha>}, path: skills/<skill>}   # 省略 git.url 时使用平台 Skill 网关
    skillRepository: {host: <git-host>, path: /<group>/<repo>.git, secretRef: agentos-skill-repository}
```

| 访问级别 | 只读绑定 | 写绑定 |
| --- | --- | --- |
| `read` | `readOnly` | 无 |
| `operate` | `readOnly` | `write` |
| `manage` | `readOnly`、`managementReadOnly` | `management` |

`operate` 与 `manage` 分别表示运行操作和资源管理权限，两个级别使用各自独立的工具集合。方案包按职责选择对应权限集。所有写调用仍受发起人的写权限及目标系统原生权限限制。

身份 `catalog` 为平台保留，用于发现各服务的工具，须对每个服务有只读访问。`approval` 环境中，`approval` 列出的写绑定工具以 kagent 原生 `requireApproval` 暂停；该列表显式声明由平台确认的写操作。平台服务（team-sessions、kagent 会话 MCP）的分级由平台维护。
`skillRepository` 设置后，平台的只读 Skill 网关代理该 Git 仓库，由 agentgateway 注入仓库凭据。

业务角色以模板文件提供，方案包 Chart 调用平台模板渲染，预置中可用 `agentos.presetSkill` 引用目录中的 Skill，完整示例见
[示例方案 Chart](../tests/fixtures/solution-chart)：

```yaml
{{ include "agentos.presets" (dict "root" . "files" (.Files.Glob "presets/engineers/*.yaml")) }}
```

`AgentTemplate` 与 `Agent` 通过 Preset 应用；未修改对象随方案升级更新，用户编辑后保留。
环境工具绑定由控制器使用 AccessPlan 的编译结果生成，详见 [Kubernetes 控制器](kubernetes-controller.md)。
`systemAgents.assistant.systemPrompt` 与 `systemAgents.roleBuilder.systemPrompt` 可覆盖平台系统 Agent 的提示词，支持模板表达式。

## 展示

控制台从方案包目录读取 `pack.json`（proto `agentos.console.v1.Pack`）并以 `/pack/` 提供其中的资源。字段均可省略，缺省时使用平台默认值：

| 字段 | 说明 |
| --- | --- |
| `title` | 顶栏与页面标题 |
| `roles[]` | `role` 角色键；`avatar` 头像图片；`rig` 可选的分件动画几何（256×342 画布上的 SVG 路径与 CSS 动作参数） |
| `tools[]` | `match` 匹配工具名或服务名的正则；`name` 品牌名；`icon` 图标；`monochrome` 暗色模式反色 |
| `locales` | 按语言的 i18next 资源，按命名空间覆盖平台文案，如角色名 `translation.role.<role>` 与工具标签 `tools.catalog.<tool>` |

资源使用方案包目录内的相对路径。部署时，方案包把 `pack.json` 与资源放在镜像的 `/pack` 下，镜像须提供 `cp`
（如基于 busybox）；平台 Chart 设置 `pack.image`（摘要固定）后，由 init 容器复制到 api 与 worker。

## 环境

环境及连接以 `proto/agentos/governance/v1/governance.proto` 为唯一模型。环境提供 `name`、`governance` 与通用门户 `links`；服务地址和凭据保存在 `EnvironmentConnection` 中。

`approval` 环境按工具分级设置原生 `requireApproval`，`direct` 按目标身份权限执行。未配置外部服务的暂停由控制台提交批准或拒绝；配置外部服务后，控制台仅展示其决定与链接。

## 外部审批

方案包实现 Connect 服务 `agentos.governance.v1.ApprovalService`：

| 方法 | 职责 |
| --- | --- |
| `ReviewApproval` | 接收原生 Agent、task、session、tool 与已观察调用，登记业务审批 |
| `GetApproval` | 按原生 task/tool 引用读取当前决定 |
| `PrepareApproval` | 核验决定并准备本次执行 |
| `RecordApprovalResult` | 接收原生调用结果；重试保持幂等 |

批准返回 `SUCCEEDED`，拒绝返回 `REJECTED` 或 `CANCELED`，等待返回 `AWAITING_APPROVAL`。结果通过通用 `Approval` 展示状态、理由、决定者、链接与说明。外部请求失败时任务继续暂停，该服务的决定作为审批来源；同次原生工具暂停采用同一类决定来源。

业务服务维护自身的业务协议、数据库、鉴权与执行守卫。AIOps 的 ChangePlan、Zammad 角色核验、`prepare_change` 与 ExtMCP 守卫由 aiops-mvp 提供，业务字段由提供方解释。Node SDK `@agentos/contracts` 与 Python `agentos-contracts` 发布同一组 proto 生成代码；方案包引用 SDK 的 proto 源码生成业务协议。

## 运行时图标

Harness 列表、选择器与编辑器共用运行时图标。kagent 沿用仓库内图标，Codex 使用 [OpenAI 开发者站图标](https://developers.openai.com/favicon.svg)，Claude Code 使用[官方文档图标](https://code.claude.com/docs/en/overview)；BYO 和未知运行时使用 Lucide Blocks。工具图标仍优先采用方案包配置。
