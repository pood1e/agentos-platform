# 扩展契约

方案包通常由依赖平台 Chart 的业务 Chart、展示镜像和环境连接器组成。平台提供交互与接入契约，方案包维护业务资源和流程。

| 扩展点 | 配置与职责 |
| --- | --- |
| Agent 团队 | Preset 中的原生 `AgentTemplate` / `Agent`，声明角色、提示词、工具和 Harness |
| Skill | `global.agentos.skills` 固定原生制品来源，平台提供共享目录与 dry-run 校验，kagent 加载内容 |
| 工具与身份 | `global.agentos.toolsets` / `identities` 编译为 AccessPlan，生成工具视图和原生确认绑定 |
| 环境 | `global.agentos.environments` 与 proto `EnvironmentConnection` 声明工具确认模式、OAuth 资源、网关与 API |
| 连接器 | 环境 MCP 服务及 `environment_connectors`，由方案包提供目标系统和各身份凭据 |
| 对话视图 | MCP Apps 元数据、`ui://` HTML 与只读取数工具，平台提供沙箱和宿主回调 |
| 外部执行 | 原生 A2A 与受限机器身份；业务服务管理触发、调度和工作流 |
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
      - skill: {name: <skill>, oci: <registry>/<image>@sha256:<digest>, path: skills/<skill>}
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

Skill 使用 digest 固定的 OCI 容器镜像与镜像内相对路径。镜像从 `scratch` 构建，只复制 Skill 内容；Substrate worker 通过原生镜像卷只读挂载，私有仓库凭据由站点配置在 worker 的镜像拉取链路。
Git 来源填写完整 `git.url` 与固定 `git.commit`，S3 来源填写原生对象版本；来源与路径由 kagent CRD 和 Harness 校验。
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

资源使用包内相对路径。展示镜像把 `pack.json` 与资源放在 `/pack`，提供 `cp`，Chart 用 `pack.image` 固定摘要后由 web 的 init 容器复制，console 主机直接提供。
`pack.json` 对应 proto `Pack`，方案 CI 可用契约包内的 `gen/schema/agentos.console.v1.Pack.jsonschema.bundle.json` 校验。
Harness 使用平台内置运行时图标，工具优先使用方案图标。

## 外部执行

外部服务使用站点 IdP 签发的机器访问令牌，直接调用 kagent `SessionService` 与原生 A2A。原生 OIDC `ScopeRule` 按主体、client 与允许 Agent 限定资源和执行操作。
客户端生成稳定的 Session requestId 与消息 messageId，重试复用原请求；任务、可信委派树与取消结果通过原生 API 查询。
业务事件、调度、截止时间、审批和工作流状态由方案服务维护。

## 环境 API 与模型

`EnvironmentConnection.apis` 声明 `service`、`readMethods` 与 `writeMethods`。
agentgateway 的 `/environments/{environment}/rpc/{service}/{method}` 按当前查看者交换令牌，提供白名单 unary Connect JSON 路由。
读写名单互斥，写方法需要用户写权限；资源和业务角色由环境服务校验。

`AgentgatewayModel` 注解 `agentos.dev/model-purpose` 区分 `language` 与 `embedding`，默认用于对话；用途同步到原生 `ModelConfig`，管理页和执行均校验用途。
MCP Apps 与语音接入分别见[对话视图](mcp-app.md)和[语音](speech.md)。
