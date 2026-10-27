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
| 案例触发 | `CaseTrigger`（proto） | 案例自动化：去重、调用指定 Agent、超时取消与事实发布 | 源事件映射、Agent 简报与事件命名空间 |

## 对话视图

工具通过 `_meta.ui.resourceUri` 关联 MIME 为 `text/html;profile=mcp-app` 的资源；取数工具可声明 `visibility: ["app"]`，
同样列入方案包的 `toolsets.readOnly`。目录路由提供视图元数据与模板，Agent 路由保留可见性并移除资源 URI，分析结果继续进入模型。

卡片默认折叠，展开后加载 View。宿主使用当前查看者凭证，经原调用 Agent 的环境身份调用同一服务的只读工具；
写操作、跨服务访问与仅模型可见工具均拒绝。`ui/message` 只预填聊天输入框；链接限 `http(s)`。

站点在平台 Chart 配置 `ingress.sandbox.host` 与 `ingress.sandbox.tlsSecret`，准备对应 DNS 与 TLS Secret。
View 使用规范默认 CSP，仅可显式申请 `data:` 静态资源，无直接网络出口。接入与验证见[对话视图](mcp-app.md)。

## 系统任务

方案镜像可在 `/pack/automation.json` 提供 `agentos.automation.v1.AutomationPresets`：

- `scheduledRuns`：kagent 官方 `CreateScheduledRunRequest`，包含稳定的 `requestId`、目标 `agent` 与 `config`。平台补齐工作空间；调度表达式、时区及超时由上游校验。预置使用 `paused: true`，由任务管理员启用。
- `scheduledRunPrompts`：按预置 `key` 管理方案说明。平台以原生 etag 更新提示词，保留任务 ID、启停、周期和执行历史；初始创建输入保持不变。
- `eventTriggers`：既有 `CaseTrigger` 列表，来源环境的 worker 读取同一份定义。`locales.<language>.translation.automation.eventNames.<eventNamespace>` 提供显示名称。

平台在启动时通过原生幂等创建接口登记定时任务，后续重启保留用户编辑、启停与删除状态。同一预置 ID 对应固定的初始输入。
具有任一平台资源管理能力的管理员可读取当前工作空间的共享定义和历史；`agentos-tasks-manage` 可维护定时任务与手动触发。定时执行使用只读服务身份，委派沿用该权限上限。
事件入口由 Chart 的 `automation.enabled` 控制；入口状态表示平台配置，worker 运行状态由来源环境维护。

MCP 接入目录展示供 Agent 调用的工具服务。自动化事件入口使用注解
`agentos.dev/connection-role: ingress`，由部署配置托管，事件触发状态在系统任务中展示。

## 环境结果读取与 API

环境的 `automationSources` 可以用 `scheduledRunPresets` 精确授权原生定时执行结果。该身份仅能调用 `list_scheduled_run_executions` 与 `get_scheduled_run_execution_result`，与 `caseAgents`、写权限和能力授权互斥。读取仅包含该次触发的原始任务及因果子任务，排除后续聊天和审批复查；结果脱敏、分页并限制响应大小。业务结果由环境校验并持久化。

`EnvironmentConnection.apis` 声明环境服务的 `service`、`readMethods` 和 `writeMethods`。平台 `/environments/{environment}/rpc/{service}/{method}` 只转发白名单中的 unary Connect JSON，按当前用户进行环境令牌交换，保留环境服务的原生错误。写方法要求用户写权限，读写名单互斥。环境服务继续负责资源、业务角色和审批校验。

## 模型用途

模型接入通过 `AgentgatewayModel` 的 `agentos.dev/model-purpose` 注解区分 `language` 与 `embedding`，未声明时为对话模型。用途随接入同步到原生 `ModelConfig`；模型页面按用途查询、分页和展示，向量模型用于知识记忆，不参与聊天 Harness 的模型选择。

## 任务标签

`pack.json` 的 `taskTags` 提供可选标签建议，例如 `["rca", "auto-remediation"]`；标签仍可由用户自定义。`locales.<language>.translation.task.tagNames` 提供显示名称，缺失时显示原始值。每个任务最多 32 个标签，每个标签最多 40 个字符。预置建议由方案包维护，标签编辑、可见范围与筛选由平台负责。

## 角色标识

角色键写在 `Agent` 的 `agentos.dev/role` 标签上，用于文案、头像与身份档案。平台保留以下角色键，其余由方案包定义：

| 角色键 | 含义 |
| --- | --- |
| `assistant` | 默认聊天入口，由平台 Chart 管理；可通过 `entryAgent` 选择其他入口 |
| `role-builder` | 角色构建，由平台 Chart 管理 |

`agentos.dev/role` 的业务角色键不限制执行拓扑。默认任务按原生 task 分组；需要把多轮执行展示为一个任务的 Agent 设置注解 `agentos.dev/task-scope: session`。

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

`operate` 与 `manage` 分别表示运行操作和资源管理权限，管理身份不隐含运行执行权限。方案包按职责选择对应权限集。所有写调用仍受发起人的写权限及目标系统原生权限限制。

身份 `catalog` 为平台保留，用于发现各服务的工具，须对每个服务有只读访问。`approval` 环境中，`approval` 列出的写绑定工具以 kagent 原生 `requireApproval` 暂停；目标系统自行审批的写工具可不列入。平台服务（team-sessions、kagent 会话 MCP）的分级由平台维护。
`skillRepository` 设置后，平台的只读 Skill 网关代理该 Git 仓库并由 agentgateway 注入凭据，Agent 不持有仓库凭据。

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

资源路径相对方案包目录，不允许 `..` 与绝对路径。部署时，方案包把 `pack.json` 与资源放在镜像的 `/pack` 下，镜像须提供 `cp`
（如基于 busybox）；平台 Chart 设置 `pack.image`（摘要固定）后，由 init 容器复制到 console。

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

批准返回 `SUCCEEDED`，拒绝返回 `REJECTED` 或 `CANCELED`，等待返回 `AWAITING_APPROVAL`。结果通过通用 `Approval` 展示状态、理由、决定者、链接与说明。外部请求失败时任务继续暂停，浏览器不能覆盖该服务的决定；同次原生工具暂停采用同一类决定来源。

业务服务维护自身的业务协议、数据库、鉴权与执行守卫。AIOps 的 ChangePlan、Zammad 角色核验、`prepare_change` 与 ExtMCP 守卫由 aiops-mvp 提供，平台不解释这些业务字段。Node SDK `@agentos/contracts` 与 Python `agentos-contracts` 发布同一组 proto 生成代码；方案包引用 SDK 的 proto 源码生成业务协议。

## 运行时图标

Harness 列表、选择器与编辑器共用运行时图标。kagent 沿用仓库内图标，Codex 使用 [OpenAI 开发者站图标](https://developers.openai.com/favicon.svg)，Claude Code 使用[官方文档图标](https://code.claude.com/docs/en/overview)；BYO 和未知运行时使用 Lucide Blocks。工具图标仍优先采用方案包配置。

## 案例自动化

环境侧的案例自动化 worker 从 `AGENTOS_AUTOMATION_CONFIG` 读取 `AutomationConfig`（proto），消费结构化 CloudEvents，
按其中取自方案包的 `trigger`（`CaseTrigger`）把源事件映射为案例：

```json
{
  "agent": {"name": "<agent>"},
  "eventNamespace": "<namespace>",
  "source": {
    "typePrefix": "alert.lifecycle.",
    "keyField": "alertId",
    "stateField": "state",
    "summaryField": "reason",
    "activeStates": ["firing"],
    "resolvedStates": ["resolved"]
  },
  "brief": "核验并分诊，返回可核验的结论。上下文：${summary}",
  "timeoutSeconds": 900,
  "cooldownSeconds": 300
}
```

案例键为事件 `source` 与 `keyField` 取值，版本为 JetStream 序号，状态不区分大小写。`activeStates` 交 `trigger.agent` 选择的工作空间 Agent 处理，同一案例复用原生会话，
重试以确定性 messageId 幂等；超过 `timeoutSeconds` 取消前台任务并升级。`resolvedStates` 记为来源已恢复，其余状态只登记。
事实发布为 `<namespace>.cases.updated`、`<namespace>.findings.proposed`、`<namespace>.findings.escalated`与 `<namespace>.feedback.recorded`，源为 `/<namespace>/<environment>`。

worker 以环境提供的 client credentials 令牌调用 `/mcp/automation`，平台通过 `automation.enabled` 启用入口。`/feedback` 与 `/metrics`
只接受配置的 OIDC 签发者与受众、`roleClaim` 中含 `feedbackRole` 的人员令牌，签名密钥经 OpenID Connect 发现获取。

自动化 worker 的 `platform_oauth` 指定令牌端点、客户端 ID 和客户端密钥文件；每次连接读取当前密钥并由 OAuthLib 获取 client credentials 令牌。平台 Chart 的 `automation.sources` 登记该客户端的环境、issuer、audience、clientId 和 subject。案例调用直接使用原生 A2A 并复用确定性 messageId。
