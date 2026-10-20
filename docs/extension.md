# 扩展契约

方案包只提供数据与资源，不修改平台代码。平台定义格式、加载与校验，方案包提供内容。方案包通常是一个依赖平台 Chart 的业务 Chart，
加上一个展示镜像与环境侧的连接器。

| 扩展点 | 形式 | 平台提供 | 方案包提供 |
| --- | --- | --- | --- |
| 团队 | kagent 原生 `AgentTemplate` 与 `Agent`，经 `agentos.presets` 渲染 | 助手与角色构建 Agent；首次缺失时初始化，之后在控制台维护 | 业务角色、提示词、工具绑定、Harness 选择 |
| 角色标识 | `Agent` 的 `agentos.dev/role` 标签与显示注解 | 保留角色键、解析与展示 | 业务角色键、显示名、说明 |
| Skill | `global.agentos.skills`，kagent 原生来源 | 共享目录、保存前 dry-run 校验、只读 Git 网关 | Skill 内容与固定版本 |
| 工具分级 | `global.agentos.toolsets` | 环境网关的读写视图与原生暂停绑定，未知工具按写处理 | 各连接器的分级 |
| 身份档案 | `global.agentos.identities` | 生成各角色的 RemoteMCPServer 绑定与环境侧账号清单 | 各角色的环境范围与访问级别 |
| 环境 | `global.agentos.environments` 与 `Environment`（proto） | 环境页、审批协调、凭据绑定 | 环境清单、治理模式与门户链接 |
| 连接器 | 环境内的 MCP 服务与 `environment_connectors` 后端描述 | 环境网关、身份映射、读写视图、ExtMCP 守卫 | MCP 服务、目标系统与各身份的后端凭据 |
| 审批提供方 | change-control 的 `ApprovalProvider` | Zammad 参考实现 | 其他 ITSM 的适配 |
| 模型 | agentgateway 原生 `AgentgatewayModel` | 管理页与 `ModelConfig` 同步 | 上游地址、协议与密钥 |
| 展示 | `pack.json` 与资源文件（proto `Pack`） | 平台通用文案、通用头像与工具图标 | 标题、角色头像、工具图标与业务文案 |
| 测评 | `evaluation.baseline`（proto `EvaluationBaseline`）、Langfuse 数据集与入口点 `agentos.evaluation.scorers` | 测评作业镜像、数据集冻结工具与内置评分器 | 样本、基线、Judge 提示与领域评分器 |
| 案例触发 | `CaseTrigger`（proto） | 案例自动化：去重、委派协调者、超时取消与事实发布 | 源事件映射、协调者简报与事件命名空间 |

## 角色标识

角色键写在 `Agent` 的 `agentos.dev/role` 标签上，用于文案、头像与身份档案。平台保留以下角色键，其余由方案包定义：

| 角色键 | 含义 |
| --- | --- |
| `assistant` | 聊天入口，由平台 Chart 管理；只能经 `delegate_coordinator` 把任务交给协调者 |
| `role-builder` | 角色构建，由平台 Chart 管理 |
| `coordinator` | 协调者，由方案包提供；每个工作空间唯一，负责调度其他成员 |

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

`Environment` 的治理模式与环境用途无关：

```proto
message Environment {
  string name = 1;
  Governance governance = 2;          // APPROVAL：写调用逐次审批；DIRECT：按原生身份权限直接执行
  optional string approval_url = 3;   // 审批系统入口，APPROVAL 时必填
  repeated Link links = 4;            // 环境门户链接，名称与地址由方案包提供
}
```

审批模式的环境须同时提供 change-control 的地址与平台协调身份的凭据，凭据以 Kubernetes Secret 挂载。环境接入时，平台侧为每个连接器生成的
网关后端带 `agentos.dev/environment`、`agentos.dev/project` 与 `agentos.dev/governance`（`approval` 或 `direct`）标签，服务端据此选择凭据与暂停策略。
接入步骤与连接器约定见[环境接入](environments.md)。

## 审批提供方

change-control 只保存方案摘要、工单关联、有效期、执行占用与回写状态，审批决定以提供方为准。提供方实现 `ApprovalProvider`：

| 方法 | 说明 |
| --- | --- |
| `create` | 按方案创建审批工单，同一方案重复调用时复用已有工单 |
| `decision` | 返回最新审批决定、操作者与理由；只认可持有审批角色的操作者，决定或方案变化时版本随之变化 |
| `result` | 把执行结果写回工单 |
| `url` | 返回工单的访问地址 |

Zammad 参考实现使用官方 REST API 与原生角色，工单组为 `AgentOS Changes`。方案登记后 1 小时内有效，批准后的执行准备窗口为 5 分钟，
均由平台固定。

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

案例键为事件 `source` 与 `keyField` 取值，版本为 JetStream 序号，状态不区分大小写。`activeStates` 交工作空间协调者处理，同一案例复用原生会话，
重试以确定性 messageId 幂等；超过 `timeoutSeconds` 取消前台任务并升级。`resolvedStates` 记为来源已恢复，其余状态只登记。
事实发布为 `<namespace>.cases.updated`、`<namespace>.findings.proposed`、`<namespace>.findings.escalated`、`<namespace>.feedback.recorded`
与 `<namespace>.evaluations.completed`，源为 `/<namespace>/<environment>`。

worker 以平台 Chart `automation.enabled` 生成的环境凭据调用 `/mcp/automation`。`/evaluations` 受理平台测评回报；`/feedback` 与 `/metrics`
只接受配置的 OIDC 签发者与受众、`roleClaim` 中含 `feedbackRole` 的人员令牌，签名密钥经 OpenID Connect 发现获取。
