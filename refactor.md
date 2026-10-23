# 维护面收敛重构

状态：第一轮已发布；第二轮首批已实现依赖清理、合并门禁、容器 CI 与 TokenReview，后续阶段保留在下表。
第一轮交付基线：平台 0.27.5（`e8daac8`），AIOps 方案包 1.24.2（`cca755a`）。

## 原则

- 平台负责运行、协作、治理、控制台与环境接入，业务方案和平台外测评分开交付。
- 优先复用维护中的组件、官方 SDK 与原生部署接口，复用现有基础设施。
- GitLab Free 为部署约束。授权、交付和验证能力按实际 API 与组件版本设计。
- 平台拥有的模型以 proto 为唯一来源；第三方模型复用官方 proto、SDK 与 CRD schema。
- 静态配置的编译与请求时授权分层，执行始终受原始发起人的当前授权约束。
- 每项替换完成一次切换并删除旧实现；通用补丁在所选上游发布版本具备对应能力后删除。

## 第一轮结果

| 阶段 | 内容 | PR | 结果 |
| --- | --- | --- | --- |
| 1 | 测评移出、Langfuse 官方镜像、OpenFGA 清理、依赖与 DNS 模块整理 | #75 | 已合入并部署 |
| 2 | release-please 与内网发布 | #78、#84 | 正式 tag 不可变，0.27.5 发布流水线通过 |
| 3 | pg-boss 持久化审批协调与续接 | #77 | 已合入并部署 |
| 4 | 平台网关与平台 API 使用工作负载 JWT | #80 | 已切换并清理旧机器令牌 |
| 5 | 环境网关与平台连接独立 Helm release | #82 | 已完成清单与资源所有权移交 |
| 6 | helm-unittest、Conftest 与 kubeconform | #83 | 已替代对应手写校验 |
| 7 | 上游收敛 | — | 待按能力提交与跟踪 |

站点采用官方 Langfuse Web/worker 4.62.0 与个人 OIDC 登录，环境和连接分别由独立 Helm release 管理。现有 11 个智能体模板配置已保留。已验证用户退出、访问令牌到期后的后台委派续接、原始发起人 OBO、只读权限上限及执行撤销。

第一轮方案见本文件 `154e1c6` 版本，现行架构与运维入口见 [代码导航](docs/code-navigation.md)。后续发布已修复 Actor 身份头、服务级 audience、MCP 发现入口与原生探针。第二轮的切换验收继续覆盖这些约束。

## 第二轮

### 现状与目标

| 环节 | 当前维护面 | 目标 |
| --- | --- | --- |
| 合并检查 | GitHub main 已要求合并前检查；内网制品在 GitLab 构建与校验 | 功能 PR 与发布 PR 在合并前通过相同门禁 |
| CI 环境 | Docker executor、mise 固定镜像、独立 PostgreSQL 服务与三路浏览器分片 | 容器隔离作业，固定工具镜像，原生服务容器与缓存 |
| 工具访问规则 | Helm、Ansible、运行时与 Rego 分别推导工具分类和绑定 | 单一静态访问计划，保留独立的权限不变量校验 |
| values 契约 | 手写 schema、脚本拼接 schema 与运行时 proto 转换并存 | 平台字段从 proto 生成，第三方字段复用原生 schema |
| 制品交付 | generic package、自定义发布清单与下载器 | 标准注册表与包管理器，保留来源、版本和完整性校验 |
| 密钥轮换 | 平台工作负载已采用 TokenReview，网关仍使用内联 JWKS | 原生远程 JWKS 与 TokenReview，覆盖轮换和撤销 |
| 模型授权 | 每次请求包含多次 kagent/Substrate RPC 与执行绑定查询 | 减少配置重复查询，保留实时身份与撤销校验；收益由测量确认 |
| 网关策略 | Gateway 级 CEL 拼接较多路由条件 | 路由或 Backend 级原生策略，验证组合后的有效权限 |
| 后置渲染 | Python 修改上游 Kubernetes 对象及内嵌配置 | 上游 values 优先，资源补丁采用 Kustomize |
| 依赖与文档 | 缺少未使用入口检查，存在历史规划和候选未使用依赖 | 按实际入口核实并清理，文档与发布状态一致 |

### 合并检查与 CI 环境

- GitHub main 通过分支保护要求检查通过后合并，功能 PR 与 release PR 使用同一组门禁。GitHub Actions 承担可公开复现的检查；依赖内网注册表的构建和发布由 GitLab 承担。
- release-please 使用仓库 `GITHUB_TOKEN` 创建发布 PR；原生工作流审批 API 自动启动受信发布分支的 PR 检查。审批作业校验同仓库、GitHub Actions 发起者与 release-please 分支，并仅持有 Actions 写权限。检查运行于 PR 合并提交。
- GitLab 的外部仓库 CI 集成和拉取镜像受版本与订阅限制，保留现有源码同步任务。外部服务可通过 GitHub Commit Status API 回写结果，这与 GitLab Premium 集成是不同能力。
- 校验作业改用容器 executor，在实施 PR 中依据现有 Runner 资源固定 Docker 或 Kubernetes 选型。每个作业使用独立工作目录，PostgreSQL 18/pgvector 以服务容器运行。
- Node、Python、Go、envtest、浏览器、Helm、Conftest、kubeconform、protoc 与 buf 固定到有摘要的 CI 镜像。GitHub 检查所需镜像和依赖可在其执行环境访问；随后删除宿主机工具安装器与 PostgreSQL 启停脚本。
- 缓存由 GitLab/GitHub 原生机制管理，以依赖锁文件及工具链版本为键，区分受信分支与外部 PR。镜像构建继续使用 rootless BuildKit。

### 工具访问计划与 values 契约

- 平台 proto 描述环境、项目与身份的静态工具访问计划，包括只读、写入与审批集合。编译器复用 `server/governance` 的规则，部署命令与平台 API 消费同一实现。
- Helm 与 Ansible 只消费编译结果，删除模板中的重复业务推导。方案包提供工具分类与默认配置，用户在平台维护的模板绑定继续保留。
- 静态计划限定可配置范围。每次调用仍校验原始发起人、执行绑定、所选工具、审批与下游 OBO 权限；MCP annotations 仅作提示，实际授权来自可信配置与服务端校验。
- Vitest 验证编译规则；Conftest 保留跨资源 audience、主体、路由覆盖和越权等不变量，删除其中重复的业务分类推导。
- 三个 Chart 中平台拥有的 values 字段由同一 proto 生成 JSON Schema，运行时直接读取同一 proto JSON。复用已有 Governance 模型和第三方 schema，避免重复定义 Kubernetes、kagent 与 agentgateway 的完整资源。
- 生成结果验证 Helm/ProtoJSON 的类型、默认值、可选字段和枚举语义一致；删除对应手写 schema、拼接与转换逻辑。

### 签名密钥与令牌校验

- 网关采用所选 agentgateway 版本原生支持的远程 JWKS，平台 API 采用现有 JOSE SDK 的远程 JWKS 缓存。issuer 与地址由受信配置指定，HTTPS 使用对应 CA 校验。
- Kubernetes TokenReview 显式传入目标 audience，校验 `authenticated`、返回 audience 与预期 ServiceAccount 主体，绑定对象有效性由 Kubernetes 验证。调用方仅授予所需的 TokenReview 创建权限。
- 密钥轮换保留覆盖未到期令牌的旧公钥，缓存刷新、未知 `kid`、网络故障与过期缓存按 SDK 的明确策略处理；无法建立有效信任时拒绝。
- 验收包含新旧密钥交叠、旧密钥撤除、错误 issuer/audience、删除绑定 Pod/ServiceAccount 及 JWKS 不可用。用户退出后，后台执行继续使用原始用户离线授权。执行绑定撤销在下一次请求生效；身份提供方授权撤销通过刷新或内省检测，验收记录实际发现时延。

### 模型授权查询收敛

- 先记录授权 RPC 数量与耗时，再分离配置读取和身份校验。Agent、模板、Harness 与模型配置通过现有读模型索引读取，并校验索引健康及资源版本。
- 每次请求继续使用原生 Substrate 接口确认当前 Actor UID，防止 Actor 恢复或替换后复用旧身份。Actor UID 到会话引用可有界缓存，期限不超过相关凭据有效期；会话授权和用户权限不随该引用一起缓存。
- 每次请求重新解析执行绑定及撤销状态，校验当前用户授权、角色上限与模型范围。配置变更、Actor 替换、执行撤销和离线授权撤销分别覆盖失效行为。
- 冷启动或索引未就绪时区分暂时不可用与权限拒绝；旧索引不产生额外授权。热路径目标为零次 kagent 配置查询，保留必要的 Substrate 身份校验和数据库撤销查询。

### 网关策略与后置渲染

- 入口的 issuer、audience 与主体约束由 HTTPRoute 上的 traffic 策略表达，连接认证和工具约束按原生支持范围配置 Backend 策略。校验策略的继承、覆盖与组合语义后，删除 Gateway 级重复 CEL。
- 控制器工具发现经受信平台网关执行；Actor 访问继续使用服务级 origin 与 audience。发现失败与空工具集合分别处理，跨服务令牌、发现身份执行工具及模型身份越权均需拒绝。
- 上游 Chart 的原生 values 优先承载配置与镜像摘要。Kubernetes 对象补丁通过 Kustomize 作为 Helm post-renderer 执行，按名称、标签和容器名定位。
- 当前 Substrate 渲染器还修改 `ConfigMap.data["config.yaml"]` 内的 `requestParking`，该字段是字符串中的 YAML，普通资源 patch 不能直接修改其内部结构。先核实所选上游 Chart 是否提供参数，缺失时优先提交上游参数支持；使用结构化 YAML 工具的必要适配保持最小。
- 替换验收包括资源语义对比、内嵌配置检查、权限负例与实际启动。具备等价行为后一次切换并删除对应 Python 渲染器，快照用于辅助检查。

### 标准制品注册表

- npm 契约发布到 GitLab npm registry，Python 契约发布到 GitLab PyPI registry，Chart 与镜像采用 OCI。参考部署交付 Ansible collection，由 `ansible-galaxy` 从固定提交安装并锁定 collection 依赖。
- 同一发布版本的包、Chart 和 collection 来自同一源码提交。正式 tag 和制品不可覆盖；重试遇到已有制品先核对身份及内容。候选构建先确认运行时镜像摘要，正式发布前检查引用闭合，避免发布后才发现 pin 不一致。
- npm 和 Python 由包管理器锁定版本及内容哈希。平台 Chart 固定自身镜像，collection 同时固定 kagent、Harness 与 Substrate 等运行时镜像，站点可明确覆写。
- Chart 使用 Helm provenance 签名与验签，OCI 使用内容摘要；下载、依赖归档及安装均验证来源和完整性。当前 Helm 3.22 的 `Chart.lock.digest` 校验依赖声明，不能代替 `.tgz` 内容校验。
- 标准安装链路完成版本一致性、完整性和部署回归后，一次删除 generic package 交付、`deployment.tar.gz`、自定义发布清单、`fetch-platform.py` 与 `platform.lock.json`。现有校验能力在新链路中具有明确对应项。

### 清理与上游收敛

- 引入 knip，声明 CLI、脚本、动态加载与生成代码的实际入口，按需排除 vendored UI 组件。候选依赖以检查结果及真实使用核实后删除，权限负例继续保留。
- 更新过时的 `plan.md` 与发布说明；`docs/delivery.md` 的官方 Langfuse 登录说明已修正，按当前实现继续校验。
- pg-boss 轮询间隔调整到 2 秒前后测量任务唤醒、审批恢复与续接延迟，以可接受延迟确定配置。
- kagent 补丁按 MemoryService、Actor 身份、Harness 工具约束与准备策略等能力提交上游；续接跟踪 [kagent #3244](https://github.com/kagent-dev/kagent/issues/3244)。
- Substrate 回移跟踪 [#2159](https://github.com/agent-substrate/substrate/pull/2159) 及恢复期间出站修复。是否删除以所选发布版本包含修复且站点回归通过为准。

### 实施顺序与验收

阶段编号沿用上一版。首批交付涵盖阶段 8 的入口、依赖与文档整理、阶段 9、10，以及阶段 11 的 TokenReview。队列轮询测量、远程 JWKS、授权查询收敛和后续阶段待实施。

| 顺序 | 阶段 | 内容 | 验收 |
| --- | --- | --- | --- |
| 1 | 9 | PR 检查与分支保护 | 普通 PR 与自动发布 PR 均触发检查，失败时不可合并 |
| 2 | 10 | 容器 executor 与固定 CI 镜像 | 作业可从干净环境复现，PostgreSQL、Go 和浏览器检查通过 |
| 3 | 8 | 入口、依赖和文档整理，队列轮询测量 | knip、现有检查通过，续接延迟满足验收界限 |
| 4 | 11 | 远程 JWKS、TokenReview 与授权查询收敛 | 轮换、绑定对象删除、旧 Actor、配置变更与撤销均验证；记录查询数与延迟 |
| 5 | 12 | 单一访问计划与 values proto | 编译结果由部署和运行时共同消费，schema 无漂移，权限不变量通过 |
| 6 | 13 | 路由级策略与原生配置/Kustomize | 渲染语义一致，内嵌配置及真实发现、调用和权限负例通过 |
| 7 | 14 | 标准注册表交付 | 从锁定制品完成干净安装与升级，篡改或错版本制品被拒绝 |
| 独立推进 | 7 | 上游收敛 | 记录 issue、PR、包含修复的发布版本与回归结果 |

阶段可按同一可验证切换单元合并交付，保留执行授权、用户会话隔离、审批与后台续接语义。新链路验收包含用户退出及令牌到期后继续执行、只读用户写入拒绝、执行撤销及身份提供方授权撤销的生效边界和现有智能体配置保留。

## 范围

本轮处理维护成本与交付一致性。平台外测评、配置 GitOps、语音链路合并、全局任务变更流和专用密钥服务另行规划。GitLab Premium 集成不作为前提。

## 依据

组件官方接口与协议约束用于验证可行性；阶段顺序、缓存边界与交付选型属于本项目设计。

- [GitHub 受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[工作流触发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)、[Commit Status API](https://docs.github.com/en/rest/commits/statuses)
- [GitLab 外部仓库 CI](https://docs.gitlab.com/ci/ci_cd_for_external_repos/)、[Runner executor](https://docs.gitlab.com/runner/executors/)、[npm](https://docs.gitlab.com/user/packages/npm_registry/) 与 [PyPI](https://docs.gitlab.com/user/packages/pypi_repository/) 注册表
- [Kubernetes TokenReview](https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-review-v1/)、[ServiceAccount 令牌](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/)
- [agentgateway 策略作用域与合并](https://agentgateway.dev/docs/kubernetes/latest/documentation/about/policies/target-merge/)、[远程 JWKS](https://agentgateway.dev/docs/kubernetes/latest/documentation/security/jwt/setup/)
- [JWT 安全实践 RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)、[OAuth 安全实践 RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)、[MCP 工具 annotations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Helm 3 OCI](https://helm.sh/docs/v3/topics/registries/)、[provenance](https://helm.sh/docs/v3/topics/provenance/)、[Chart.lock 实现](https://github.com/helm/helm/blob/v3.22.0/internal/resolver/resolver.go#L195)、[post-rendering](https://helm.sh/docs/v3/topics/advanced/#post-rendering)
- [Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)、[Ansible collection 安装](https://docs.ansible.com/ansible/latest/collections_guide/collections_installing.html)、[knip 入口配置](https://knip.dev/reference/configuration)
