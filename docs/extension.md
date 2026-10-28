# 扩展契约

方案包通常由依赖平台 Chart 的业务 Chart、展示镜像和环境连接器组成。平台提供交互与接入契约，方案包维护业务资源和流程。

| 扩展点 | 配置与职责 |
| --- | --- |
| Agent 团队 | Preset 中的原生 `AgentTemplate` / `Agent`，声明角色、提示词、工具和 Harness |
| Skill | `global.agentos.skills` 使用原生来源，固定内容版本；平台提供共享目录、dry-run 校验与只读 Git 网关 |
| 工具与身份 | `global.agentos.toolsets` / `identities` 编译为 AccessPlan，生成工具视图和原生确认绑定 |
| 环境 | `global.agentos.environments` 与 proto `EnvironmentConnection` 声明工具确认模式、OAuth 资源、网关与 API |
| 连接器 | 环境 MCP 服务及 `environment_connectors`，由方案包提供目标系统和各身份凭据 |
| 对话视图 | MCP Apps 元数据、`ui://` HTML 与只读取数工具，平台提供沙箱和宿主回调 |
| 外部执行 | 可选 `/mcp/executions`，外部服务管理业务触发、调度和工作流 |
| 模型 | 原生 `AgentgatewayModel`，平台同步 `ModelConfig` 并提供管理界面 |
| 语音 | 可选 `SpeechConfiguration`，站点提供 ASR / TTS 服务与凭据 |
| 展示 | proto `Pack` 对应的 `pack.json` 和资源镜像，提供标题、角色、图标与文案 |

## Chart 入参

业务 Chart 依赖平台 Chart，通过 Helm 全局值 `global.agentos` 提供团队配置，平台与环境套件读取同一份值：

```yaml
global:
  agentos:
    environments:
      - {name: <environment>, governance: approval}
    toolsets:
      <service>:
        readOnly: [<tool>, ...]
        write: [<tool>, ...]
        approval: [<tool>, ...]
        managementReadOnly: [<tool>, ...]
        management: [<tool>, ...]
    identities:
      - name: <role>
        environments: [<environment>, ...]
        services: {<service>: read}
    skills:
      - skill: {name: <skill>, git: {commit: <sha>}, path: skills/<skill>}
    skillRepository: {host: <git-host>, path: /<group>/<repo>.git, secretRef: agentos-skill-repository}
```

| 访问级别 | 只读工具 | 写工具 |
| --- | --- | --- |
| `read` | `readOnly` | 无 |
| `operate` | `readOnly` | `write` |
| `manage` | `readOnly`、`managementReadOnly` | `management` |

`operate` 与 `manage` 分别使用运行操作和资源管理工具集合，所有写调用仍受发起人与目标系统权限约束。
保留身份 `catalog` 对每个服务具有只读发现权限。身份省略 `environments` 时覆盖全部环境。

`governance: approval` 按 `toolsets.approval` 设置 kagent 原生 `requireApproval`，由控制台提交批准或拒绝；省略该列表时使用 `write` 与 `management`。
`governance: direct` 按身份权限直接调用。业务审批、工单、规则和结果回写由业务服务实现。
环境连接与生命周期见[环境接入](environments.md)。

Skill 省略 `git.url` 时使用平台 Skill 网关；`skillRepository` 指定代理的只读仓库。
业务角色模板通过平台共享模板生成 Preset，`agentos.presetSkill` 可引用 Skill 目录：

```yaml
{{ include "agentos.presets" (dict "root" . "files" (.Files.Glob "presets/engineers/*.yaml")) }}
```

示例见[方案 Chart](../tests/fixtures/solution-chart)。未修改预置随方案升级更新，用户编辑后保留，详见[控制器](kubernetes-controller.md)。
`systemAgents.assistant.systemPrompt` 与 `systemAgents.roleBuilder.systemPrompt` 可覆盖系统提示词，支持模板表达式。

## 角色与展示

`Agent` 标签 `agentos.dev/role` 是角色键，用于文案、头像与身份档案。平台保留 `assistant` 和 `role-builder`；`entryAgent` 选择默认聊天入口。
执行拓扑取自原生 task / session。默认按 task 分组，`agentos.dev/task-scope: session` 将多轮展示为一个任务。
用户编辑的 `agentos.dev/display-name` / `agentos.dev/description` 优先于方案文案。

控制台以 `/pack/` 提供方案包资源，字段可按需配置：

| 字段 | 内容 |
| --- | --- |
| `title` | 顶栏与页面标题 |
| `roles[]` | `role`、`avatar`，以及可选动画几何 `rig` |
| `tools[]` | `match` 正则、`name`、`icon` 与暗色模式反色 `monochrome` |
| `locales` | i18next 资源，如 `translation.role.<role>`、`tools.catalog.<tool>` |

资源使用包内相对路径。展示镜像把 `pack.json` 与资源放在 `/pack`，提供 `cp`，Chart 用 `pack.image` 固定摘要后由 init 容器复制。
Harness 使用平台内置运行时图标，工具优先使用方案图标。

## 外部执行

站点在 `execution.sources` 登记 OIDC client credentials 身份与允许启动的 Agent；列表为空时部署省略 `/mcp/executions`：

```yaml
execution:
  sources:
    - issuer: https://identity.example.com/realms/operations
      audience: agentos-executions
      clientId: analysis-controller
      subject: <service-account-user-id>
      agents: [{namespace: agentos, name: diagnosis}]
```

- `run_execution`：请求使用 `RunExecutionRequest`，调用方生成 UUID；同请求重试复用原生会话和 messageId，输入保持一致。
- `get_execution`：按执行引用读取本调用方的任务与因果子任务，结果脱敏、分页并限制响应大小。
- `cancel_execution`：撤销执行授权并取消未结束委派，尚未确认接收的请求亦可取消。

签名、issuer、audience、azp、sub 与 Agent 范围逐次核验，后台调用保留执行树初始权限上限。
外部服务独立管理事件、触发条件、频率、截止时间、业务结果及工作流存储。

## 环境 API 与模型

`EnvironmentConnection.apis` 声明 `service`、`readMethods` 与 `writeMethods`。
平台 `/environments/{environment}/rpc/{service}/{method}` 按当前用户交换令牌，只转发白名单 unary Connect JSON，并保留环境服务错误。
读写名单互斥，写方法需要用户写权限；资源和业务角色由环境服务校验。

`AgentgatewayModel` 注解 `agentos.dev/model-purpose` 区分 `language` 与 `embedding`，默认用于对话；用途同步到原生 `ModelConfig`，管理页和执行均校验用途。
MCP Apps 与语音接入分别见[对话视图](mcp-app.md)和[语音](speech.md)。
