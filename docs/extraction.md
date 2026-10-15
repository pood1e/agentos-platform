# 抽取方案

基线为 aiops-mvp `3ad31c1`（2026-10-15）。平台代码与业务内容在 aiops-mvp 中已基本分层：服务端只在审批适配、协调角色识别与环境模型上依赖业务，
前端只在角色头像、工具图标与业务文案上依赖业务。按一次性迁移推进：平台仓库接收通用代码，aiops-mvp 同步改为依赖平台的 AIOps 方案包，
不保留双轨实现。

## 路径映射

| aiops-mvp 路径 | 去向 | 处理 |
| --- | --- | --- |
| `proto/aiops/console/v1`、`proto/aiops/management/v1`、`proto/aiops/kagent/v1` | 平台 `proto/agentos/...` | 包名改为 `agentos.*` |
| `proto/aiops/operations/v1` | 平台 `proto/agentos/governance/v1` | `Environment` 按[扩展契约](extension.md#环境)泛化 |
| `server/kagent`、`server/read-model`、`server/console`、`server/management`、`server/knowledge`、`server/shared`、`shared/` | 平台 | 角色按保留角色键识别；控制台加载方案包展示 |
| `server/team-sessions` | 平台 | `delegate_supervisor` 改为 `delegate_coordinator`，协调者按角色键查找 |
| `server/operations` | 平台 | 分级的加载保留，内容外置；治理模式取自网关后端的 `agentos.dev/governance` 标签 |
| `server/change-control` 的 `main`、`service`、`store`、`ext-mcp` | 平台 | 抽出审批提供方接口 |
| `server/change-control` 的 `zammad`、`tickets` | 平台 `server/change-control/providers/zammad` | Zammad 参考提供方 |
| `src/`（不含下列业务资源） | 平台 | 环境页的门户链接改读 `Environment.links` |
| `src/features/shared/Mascot*`、`design/mascots/`、`public/mascots/` | 方案包 `pack.json` | 平台按角色键加载头像与分件动画，缺省用通用图标 |
| `src/features/shared/ToolIcon.tsx` 中的系统映射、`public/icons/`、业务工具标签与角色文案 | 方案包 `pack.json` | 平台保留通用文案与 kagent、MCP 图标 |
| `charts/aiops-mvp/templates` | 平台 `charts/agentos` | 资源名前缀、入口域名、OIDC 与注册表参数化 |
| `charts/aiops-mvp/presets/system`、`presets/platform-tools.yaml` | 平台 | 入口与角色构建 Agent、平台服务分级 |
| `charts/aiops-mvp/presets/engineers`、`identities.yaml`、`toolsets.yaml`、`skills.yaml` | 方案包 | 经 `global.agentos` 与 `agentos.presets` 提供 |
| `skills/` | 方案包 | |
| `runtime/kagent`、`runtime/substrate`、`runtime/harness-toolbox` | 平台 | 固定上游版本与补丁；镜像标签指向本仓库 |
| `runtime/jumpserver-mcp`、`runtime/keycloak-mcp`、`runtime/zammad-mcp` | 方案包 | 连接器 |
| `deploy/`（不含历史迁移剧本） | 平台 | 单节点参考部署；清单、域名、注册表、OIDC、模型与应用值改为部署时传入的站点变量 |
| `deploy/migrate.yaml`、`deploy/cleanup-migration.yaml`、`deploy/database/*-migration.yaml`、`deploy/values/app.yaml` | 方案包 | 历史迁移与站点值 |
| `environments/templates` 的 `gateway*`、`platform-*`、`change-control`，`environments/connect.yaml`，`bootstrap/zammad.rb` 的审批部分 | 平台环境套件 `environments/` | 连接器后端改为 `environment_connectors` 数据描述；团队配置读方案 Chart 的 `global.agentos`；Zammad 审批对象由套件引导，协调账号令牌由 Zammad 生成 |
| `environments/` 其余（NetBox、JumpServer、Zammad、Keycloak、观测、存储、虚机、历史迁移） | 方案包 | 目标系统栈 |
| `tests/fake-kagent`、`tests/e2e` 与通用夹具 | 平台 | 业务夹具随方案包 |
| `ci/`（不含连接器镜像与 `ci/runner`） | 平台 | 构建 console、kagent / Substrate 补丁与 Harness 镜像并发布平台 Chart；runner 标签、BuildKit 镜像与镜像源改为 CI/CD 变量 |
| `ci/keycloak.gitlab-ci.yml`、`ci/zammad.gitlab-ci.yml`、`ci/runner/` | 方案包 | 连接器镜像与构建机置备 |
| `third_party/` | 平台 | 官方协议与 CRD |

标签与注解前缀 `aiops.dev/` 改为 `agentos.dev/`；环境变量 `AIOPS_*` 改为 `AGENTOS_*`。

## 泛化改动

| 现状 | 目标 |
| --- | --- |
| `EnvironmentKind` 只有 `REAL` 与 `SIM`，真实环境审批、仿真环境直接执行 | `Governance`：`APPROVAL` 或 `DIRECT`，与环境用途无关 |
| `identity_url`、`asset_access_url` 固定指向 Keycloak 与 JumpServer | `repeated Link links`，名称与地址由方案包提供 |
| 协调角色固定为名为 `supervisor` 的 Agent | 保留角色键 `coordinator`，按 `agentos.dev/role` 标签查找，工作空间内唯一 |
| change-control 直接调用 Zammad | 审批提供方接口，Zammad 为参考实现 |
| Chart 名、资源名与网关服务名带 `aiops-mvp` 前缀 | 平台 Chart 与资源统一使用 `agentos` 前缀 |
| 预置、分级、身份档案与 Skill 是 Chart 内文件，环境清单为 `managedEnvironments` | Helm 全局值 `global.agentos`，业务角色经 `agentos.presets` 渲染 |
| 头像、工具图标与业务文案内置于前端 | 方案包 `pack.json` 与展示镜像 |
| Harness 预设 `operations`、`knowledge` | `standard`、`memory` |

## 切换步骤

1. 平台仓库迁入通用代码，完成改名与泛化，补齐 fake kagent、单元与浏览器测试，发布镜像与平台 Chart。
2. aiops-mvp 同步切换为 AIOps 方案包：删除已迁出代码，Chart 依赖平台 Chart 并提供预置、分级、身份档案、Skill、文案与连接器；
   `aiops-mvp` 前缀的 Kubernetes 资源、网关服务名与 Helm release 由一次性 playbook 迁移为 `agentos`。aiops-mvp 侧的改动在其仓库单独跟踪。
3. 在开发环境部署两者，按 aiops-mvp 现有验收（聊天委派、真实环境审批执行、仿真环境直接执行、知识检索、Harness 切换）通过后合并发布。

## 构建与发布

本仓库公开，由 GitLab 侧拉取后沿用现有 GitLab CI、Runner 与内部镜像仓库构建并发布镜像与 Chart，见[构建与部署](delivery.md)。
