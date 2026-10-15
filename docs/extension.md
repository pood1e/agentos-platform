# 扩展契约

方案包只提供数据与资源，不修改平台代码。平台定义格式、加载与校验，方案包提供内容。

| 扩展点 | 形式 | 平台提供 | 方案包提供 |
| --- | --- | --- | --- |
| 团队 | kagent 原生 `AgentTemplate` 与 `Agent` | 入口 Agent 与角色构建 Agent；首次缺失时初始化，之后在控制台维护 | 业务角色、提示词、工具绑定、Harness 选择 |
| 角色标识 | `Agent` 标签与注解 | 解析与展示 | 角色键、显示名、说明 |
| Skill | kagent 原生来源：Git 完整提交、OCI 摘要、S3 版本、相对目录 | 共享目录、保存前 dry-run 校验、只读 Git 网关 | Skill 内容与固定版本 |
| 工具分级 | `toolsets.yaml`：每个 MCP 服务的 `readOnly` 与 `write` 工具 | 生成环境网关的读写视图与原生暂停绑定，未知工具按写处理 | 各连接器的分级 |
| 身份档案 | `identities.yaml`：角色的环境范围与各服务访问级别 | 生成 RemoteMCPServer 绑定与环境侧的账号清单 | 各角色的访问级别 |
| 环境 | `Environment`（proto）：名称、治理模式、审批入口、门户链接 | 环境页、审批协调、凭据绑定 | 环境清单与连接凭据 |
| 连接器 | 环境内带统一标签的 MCP Service | 汇聚、身份映射、读写视图、ExtMCP 守卫 | MCP 服务与其目标系统 |
| 审批提供方 | change-control 的提供方接口 | Zammad 参考实现 | 其他 ITSM 的适配 |
| 模型 | agentgateway 原生 `AgentgatewayModel` | 管理页与 `ModelConfig` 同步 | 上游地址、协议与密钥 |
| 文案与图标 | i18n 资源、角色头像、工具图标映射 | 平台通用文案与默认图标 | 角色名、工具标签与图标 |

## 角色标识

角色由 `Agent` 的标签与注解声明，平台不写死角色名：

| 键 | 位置 | 含义 |
| --- | --- | --- |
| `agentos.dev/role` | 标签 | 角色键，用于文案、头像与身份档案 |
| `agentos.dev/system-role` | 标签 | `entry`（聊天入口）或 `role-builder`（角色构建），由平台 Chart 管理 |
| `agentos.dev/coordinator` | 标签 | `true` 表示协调角色；每个工作空间唯一，入口 Agent 只能委派给它 |
| `agentos.dev/display-name`、`agentos.dev/description` | 注解 | 用户自定义的显示名与说明，优先于方案包文案 |

## 工具分级与身份档案

`toolsets.yaml` 按 MCP 服务列出工具：

```yaml
<service>:
  readOnly: [<tool>, ...]
  write: [<tool>, ...]
```

`identities.yaml` 定义角色的环境范围与访问级别，级别名由方案包按服务定义，平台只要求每个级别映射到一组工具与一份目标系统账号：

```yaml
engineer_profiles:
  - name: <role>
    environments: [<environment>, ...]
    services: {<service>: <level>, ...}
```

平台服务（team-sessions、kagent 会话 MCP）的分级由平台维护。

## 环境

`Environment` 取代 aiops-mvp 中的真实 / 仿真二分与固定的身份、资产链接：

```proto
message Environment {
  string name = 1;
  Governance governance = 2;          // APPROVAL：写调用逐次审批；DIRECT：按原生身份权限直接执行
  optional string approval_url = 3;   // 审批系统入口，APPROVAL 时必填
  repeated Link links = 4;            // 环境门户链接，名称与地址由方案包提供
}
```

审批模式的环境须同时提供 change-control 的地址与平台协调身份的凭据，凭据以 Kubernetes Secret 挂载。

## 审批提供方

change-control 只保存方案摘要、工单关联、有效期、执行占用与回写状态，审批决定以提供方为准。提供方实现四个能力：

| 能力 | 说明 |
| --- | --- |
| 建单 | 按方案创建审批工单，返回工单号与入口链接 |
| 读取决定 | 返回最新审批历史的决定、操作者与理由 |
| 核验审批人 | 判断操作者在提供方中是否持有审批角色 |
| 回写结果 | 把执行结果写回工单 |

Zammad 参考实现使用官方 REST API 与原生角色；工单有效期与准备窗口由平台配置，默认 1 小时与 5 分钟。
