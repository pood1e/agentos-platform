# 扩展契约

平台定义通用契约、加载与校验，方案包提供资源、展示内容及业务服务。方案包通常是一个依赖平台 Chart 的业务 Chart，
加上一个展示镜像与环境侧的连接器。

| 扩展点 | 形式 | 平台提供 | 方案包提供 |
| --- | --- | --- | --- |
| 团队 | kagent 原生 `AgentTemplate` 与 `Agent`，经 `agentos.presets` 渲染 | 助手与角色构建 Agent；首次缺失时初始化，之后在控制台维护 | 业务角色、提示词、工具绑定、Harness 选择 |
| 角色标识 | `Agent` 的 `agentos.dev/role` 标签与显示注解 | 保留角色键、解析与展示 | 业务角色键、显示名、说明 |
| Skill | `global.agentos.skills`，kagent 原生来源 | 共享目录、保存前 dry-run 校验、只读 Git 网关 | Skill 内容与固定版本 |
| 工具分级 | `global.agentos.toolsets` | 环境网关的读写视图与原生暂停绑定，未知工具按写处理 | 各连接器的分级 |
| 身份档案 | `global.agentos.identities` | 生成各角色的 RemoteMCPServer 绑定与环境侧账号清单 | 各角色的环境范围与访问级别 |
| 环境接入 | `global.agentos.environments` 与 `Environment`（proto） | 审批协调、凭据绑定 | 环境标识与治理模式 |
| 连接器 | 环境内的 MCP 服务与 `environment_connectors` 后端描述 | 环境网关、身份映射、读写视图 | MCP 服务、目标系统与各身份的后端凭据 |
| 审批提供方 | proto `ApprovalService`，Connect RPC | 原生确认与外部决定协调 | 业务审批、方案、执行守卫与结果回写 |
| 模型 | agentgateway 原生 `AgentgatewayModel` | 管理页与 `ModelConfig` 同步 | 上游地址、协议与密钥 |
| 语音 | `speech`（proto `SpeechConfiguration`） | 可选 ASR/TTS 接入、能力查询与聊天控件 | 站点提供模型服务、音色及凭据 |
| 展示 | `pack.json` 与资源文件（proto `Pack`） | 平台通用文案、通用头像与工具图标 | 标题、角色头像、工具图标与业务文案 |
| 测评 | `evaluation.baseline`（proto `EvaluationBaseline`）、Langfuse 数据集与入口点 `agentos.evaluation.scorers` | 测评作业镜像、数据集冻结工具与内置评分器 | 样本、基线、Judge 提示与领域评分器 |
| 案例触发 | `CaseTrigger`（proto） | 案例自动化：去重、调用指定 Agent、超时取消与事实发布 | 源事件映射、Agent 简报与事件命名空间 |

## 系统任务

方案镜像可在 `/pack/automation.json` 提供 `agentos.automation.v1.AutomationPresets`：

- `scheduledRuns`：kagent 官方 `CreateScheduledRunRequest`，包含稳定的 `requestId`、目标 `agent` 与 `config`。平台补齐工作空间；调度表达式、时区及超时由上游校验。预置使用 `paused: true`，由任务管理员启用。
- `eventTriggers`：既有 `CaseTrigger` 列表，来源环境的 worker 读取同一份定义。`locales.<language>.translation.automation.eventNames.<eventNamespace>` 提供显示名称。

平台在启动时通过原生幂等创建接口登记定时任务，后续重启保留用户编辑、启停与删除状态。同一预置 ID 对应固定的初始输入。
具有任一平台资源管理能力的管理员可读取当前工作空间的共享定义和历史；`agentos-tasks-manage` 可维护定时任务与手动触发。定时执行使用只读服务身份，委派沿用该权限上限。
事件入口由 Chart 的 `automation.enabled` 控制；入口状态表示平台配置，worker 运行状态由来源环境维护。

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
| `manage` | `readOnly`、`managementReadOnly` | `write`、`management` |

身份 `catalog` 为平台保留，用于发现各服务的工具，须对每个服务有只读访问。写绑定在 `approval` 环境以 kagent 原生 `requireApproval` 暂停。平台服务（team-sessions、kagent 会话 MCP）的分级由平台维护。
`skillRepository` 设置后，平台的只读 Skill 网关代理该 Git 仓库并由 agentgateway 注入凭据，Agent 不持有仓库凭据。

业务角色以模板文件提供，方案包 Chart 调用平台模板渲染，预置中可用 `agentos.presetSkill` 引用目录中的 Skill，完整示例见
[示例方案 Chart](../tests/fixtures/solution-chart)：

```yaml
{{ include "agentos.presets" (dict "root" . "files" (.Files.Glob "presets/engineers/*.yaml")) }}
```

`AgentTemplate` 只在缺失时创建，之后保留控制台的修改；`Agent` 保留控制台选择的 Harness；环境工具绑定按身份档案追加。
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

## 测评

基线（proto `EvaluationBaseline`）经平台 Chart 值 `evaluation.baseline` 提供，样本保存在 Langfuse 数据集。方案包用平台发布的
`agentos-evaluation` wheel 冻结数据集，输出带数据集版本与样本摘要的完整基线；留出样本只在首次建立基线时以文件传入，不入库：

```sh
agentos-evaluation-seed --baseline baseline.json --cases cases.json --job-image <evaluator>@sha256:<digest> [--holdout-file <file>]
```

`rules[].name` 选择评分器。内置评分器读取样本预期中的 proto `Expectation` 字段，预期可以携带方案包评分器需要的其他字段：

| 评分器 | 预期字段 | 取值 |
| --- | --- | --- |
| `correctness` | `reference` | Judge 模型按 `judgePrompt` 对照参考答案给出 0–1 |
| `grounding` | `requiredTools` | 每个工具都有成功的原生执行时为 1 |
| `permissions` | `forbiddenTools` | 没有调用匹配禁止模式（不区分大小写的通配）时为 1，失败的尝试同样计入 |
| `conciseness` | `maxCharacters`、`maxWords` | 回答同时满足两项上限时为 1 |

工具名去掉 MCP 服务前缀后匹配，委派成员的调用一并计入。领域评分器以入口点注册，工厂接收基线，返回把 `Sample` 映射为 `Score` 的函数：

```toml
[project.entry-points."agentos.evaluation.scorers"]
recovery = "pack_scoring:recovery"
```

方案包镜像基于平台测评镜像安装该包，并把镜像摘要写入基线的 `jobImage`；只用内置评分器时直接使用平台测评镜像。
规则名重复、未注册或与内置评分器同名时作业失败。

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
事实发布为 `<namespace>.cases.updated`、`<namespace>.findings.proposed`、`<namespace>.findings.escalated`、`<namespace>.feedback.recorded`
与 `<namespace>.evaluations.completed`，源为 `/<namespace>/<environment>`。

worker 以平台 Chart `automation.enabled` 生成的环境凭据调用 `/mcp/automation`。`/evaluations` 受理平台测评回报；`/feedback` 与 `/metrics`
只接受配置的 OIDC 签发者与受众、`roleClaim` 中含 `feedbackRole` 的人员令牌，签名密钥经 OpenID Connect 发现获取。
