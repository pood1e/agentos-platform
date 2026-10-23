# 维护面收敛重构

状态：第一轮已合入并以 0.27.1 发布，AIOps 方案包升级与站点切换待执行；第二轮实施中。
基线：平台 0.27.1（`154e1c6`），AIOps 方案包 1.23.4（锁定平台 0.26.5）。

## 原则

- 平台保留运行、协作、治理、控制台与环境接入，测评移出平台。
- 优先使用组件原生能力，不新增常驻基础设施服务。
- GitLab 实例无 Premium 授权，方案不依赖 Premium 功能。
- 同一规则与数据模型只实现一次，其他位置消费生成结果。
- 通用改动提交上游，平台补丁随上游版本删除。

## 第一轮结果

| 阶段 | 内容 | PR | 状态 |
| --- | --- | --- | --- |
| 1 | 测评移出、Langfuse 官方镜像、OpenFGA 清理、未使用依赖、DNS 模块 | #75 | 已合入 |
| 2 | release-please 与内网发布 | #76、#78、#84 | 已合入。0.27.0 的发布提交未通过格式检查，tag 不可变，正式版本为 0.27.1（#85） |
| 3 | pg-boss 持久化审批协调与续接 | #77 | 已合入 |
| 4 | 平台网关与平台 API 使用工作负载 JWT | #80 | 已合入 |
| 5 | 环境网关与平台连接发布为 Helm Chart | #82 | 已合入 |
| 6 | helm-unittest、Conftest 与 kubeconform 替代手写断言 | #83 | 已合入 |
| 7 | 上游收敛 | — | 未开始；kagent 补丁 2420 行，Substrate 补丁 5659 行 |

相对 `40e4bc1` 改动 325 个文件，新增 8975 行、删除 11748 行。第一轮的设计与验证记录见本文件 `154e1c6` 版本，现行架构以 `docs/` 为准。

### 第一轮切换（待执行）

1. 部署观测：官方 Langfuse Web 镜像，按站点配置 OIDC 或账号登录。
2. AIOps 方案包锁定平台 0.27.1，部署平台与方案包新版本。
3. 一次性移交环境接入资源的 release 清单与所有权，由环境 Chart 接管；通过平台接口完成模板绑定调整。
4. 对移除的身份完成模板解绑与原生凭据撤销，验收新身份链路后清理旧机器令牌 Secret 与 key ConfigMap。

回退时重新部署 0.26.5、AIOps 1.23.4 及其环境套件，同步移交资源所有权。

## 第二轮

### 现状

| 环节 | 现状 | 问题 |
| --- | --- | --- |
| PR 检查 | GitHub main 未启用分支保护，PR 与 release PR 合并前不运行检查，检查只在合并后的 GitLab 流水线执行 | 0.27.0 的发布提交合并后才发现格式错误 |
| CI 执行环境 | GitLab shell executor；`ci/with-postgres.sh` 在宿主机启动 PostgreSQL，`ci/tools.sh` 与 `ci/*-env.sh` 在宿主机安装工具和虚拟环境 | 宿主机磁盘耗尽导致流水线失败，作业之间共享主机状态 |
| 工具访问规则 | 身份、环境、工具集、读写层级与审批的推导分别实现于 `_environment-tools.tpl`、`initialize-service-tools.yaml.j2`、`identity-views.yaml`、`tests/policies/bindings.rego` 与 `server/governance/bindings.ts` | 规则变更需同步五处、四种语言 |
| values 契约 | `charts/agentos/values.schema.json` 手写；环境与连接 Chart 的 schema 由脚本拼接；平台 API 读取由模板转换的 `GovernanceConfig` | 同一数据存在三种表示 |
| 制品分发 | 契约、wheel 与部署源码包发布到 generic package，配套自定义发布清单；方案包以 `fetch-platform.py` 与 `platform.lock.json` 下载并校验 | 自研分发与校验链路 |
| 签名密钥 | Actor 与 Kubernetes 的 JWKS 在部署时内联进网关策略与平台配置 | 密钥轮换后认证失败，需重新部署 |
| 模型授权 | 每次模型请求经 extAuth 回到平台 API，执行 5–6 次 kagent 与 Substrate RPC 及数据库查询，失败即拒绝 | 延迟高，全部模型调用依赖平台 API 的实时查询 |
| 网关授权 | `gateway-auth.yaml` 以 Helm 循环拼接一条 Gateway 级 CEL 表达式 | 难以阅读与测试 |
| 后置渲染 | Python 脚本修改 Substrate 与 kagent 上游 Chart 的渲染结果，配套 unittest | 自研补丁逻辑 |
| 残留 | 依赖 `ajv`、`canonicalize`、`isomorphic-git`、`react-diff-viewer-continued` 与若干文件无引用；部分测试只断言已删除功能不存在；`docs/delivery.md` 仍描述已删除的 Langfuse 镜像，`plan.md` 仍包含测评 | 维护噪音与错误文档 |

### 设计

#### PR 检查

- GitHub main 启用分支保护，要求检查通过后合并，禁止直接推送。
- GitHub Actions 运行无需内网资源的检查：buf lint、Biome、tsc、Vitest（PostgreSQL 服务容器）、Playwright、Ruff 与 pytest、Chart 校验。release PR 同样受检查约束。
- 依赖内网注册表与运行时镜像的构建和发布保留在 GitLab。无 Premium 授权时，GitLab 不能为 GitHub PR 回写检查状态，也不能配置拉取镜像，GitHub 到 GitLab 的同步保留 `ci/source-sync.py` 定时任务。

#### CI 执行环境

- GitLab Runner 改用容器 executor（Docker 或 Kubernetes），每个作业使用干净工作目录；依赖缓存使用 GitLab `cache:`，以锁文件为键。
- PostgreSQL 以 `services` 提供，删除 `ci/with-postgres.sh`。
- Node、Python、Helm、helm-unittest、Conftest、kubeconform、protoc 与 buf 固化到固定摘要的 CI 镜像，删除 `ci/tools.sh` 下载器与 `ci/*-env.sh`。镜像构建继续使用 rootless BuildKit。

#### 工具访问规则单一实现

- proto 定义访问计划：每个环境、项目与身份的只读工具、写工具与需审批工具。
- 计划由 `server/governance` 的现有规则生成，平台 API 运行时使用同一实现。部署时由平台发布的命令行入口生成计划，作为 Chart values 与 Ansible 变量。
- `_environment-tools.tpl`、`initialize-service-tools.yaml.j2` 与 `identity-views.yaml` 只遍历计划；删除 `tests/policies/bindings.rego` 中的推导，规则测试由 Vitest 承担。

#### values 契约使用 proto

- proto 定义 `global.agentos` 与三个 Chart 的 values，protoc-gen-jsonschema 生成各 Chart 的 `values.schema.json`，上游 CRD 片段继续由 CRD 生成。
- 删除手写 schema 与 `scripts/generate-environment-schema.mjs` 的拼接逻辑；平台 API 直接读取同一 proto 的 JSON，删除 Helm 中的 `GovernanceConfig` 转换。

#### 标准制品注册表

- npm 契约发布到 GitLab npm registry，Python 契约发布到 GitLab PyPI registry，Chart 继续使用 OCI 注册表，镜像摘要随各 Chart values 发布。
- 单节点参考部署发布为 Ansible collection，从版本 tag 安装；环境接入已由 Chart 承载。
- 方案包以 npm、pip 锁文件及 Chart 版本锁定平台。删除 `deployment.tar.gz`、generic package 发布、`ci/registry.py`、`ci/manifest.py`，以及方案包的 `fetch-platform.py` 与 `platform.lock.json`。

#### 签名密钥与令牌校验

- 平台网关的 Actor 与 Kubernetes issuer 使用 `jwks.remote`，删除 values 中内联的 JWKS；Kubernetes issuer 的 JWKS 端点对网关开放读取。
- 平台 API 以 TokenReview 校验 Kubernetes 令牌，以远程 JWKS 校验 Actor JWT。

#### 模型授权

- Agent、模板与模型配置从读模型索引读取；Actor 到会话的解析按 Actor UID 缓存，缓存期不超过令牌有效期。
- 每次请求保留执行绑定的撤销检查。

#### 网关授权

各路由的 issuer、audience 与主体约束以挂在 HTTPRoute 或 Backend 上的 AgentgatewayPolicy 表达，删除 Gateway 级拼接的 CEL。

#### 后置渲染

Substrate 与 kagent 上游 Chart 的修改改为 Kustomize patch，经 Helm post-renderer 执行并以渲染快照测试；删除 Python 后置渲染器及其 unittest。

#### 残留清理与静态检查

- 删除未使用依赖、文件，以及只断言已删除功能不存在的测试。
- `npm run check` 增加 [knip](https://knip.dev)，忽略 shadcn 组件与手动验证脚本入口。
- 修正 `docs/delivery.md` 的 Langfuse 说明与 `plan.md` 的测评条目。
- pg-boss 轮询间隔由 0.5 秒调整为 2 秒。

#### 上游收敛

- kagent：`platform.patch` 按能力拆分为上游 PR，包括 MemoryService 的身份范围与单条删除、持久化接口的 Actor JWT、Claude 工具白名单与 PreToolUse、首次准备的出站策略；合入并发布后删除对应补丁。续接逻辑在 [kagent #3244](https://github.com/kagent-dev/kagent/issues/3244) 修复后删除。
- Substrate：kagent main 已依赖 kagent-dev/substrate v0.6.0，其中包含 [#2159](https://github.com/agent-substrate/substrate/pull/2159)。随 kagent 下一版本升级并删除该回移；恢复期间放行出站的修复提交上游。

### 实施顺序

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 8 | 残留清理、knip、文档修正、pg-boss 轮询间隔 | `npm run verify`，knip 无告警 |
| 9 | GitHub PR 检查与分支保护 | 功能 PR 与 release PR 未通过检查时不可合并 |
| 10 | 容器 executor 与 CI 镜像 | 作业使用干净工作目录，宿主机无持久依赖 |
| 11 | 远程 JWKS、TokenReview 与模型授权缓存 | 签名密钥轮换无需重新部署；单次模型请求不调用 kagent |
| 12 | 访问计划与 values proto | 规则与 values 模型各只存在一处，三个 Chart 的 schema 由 proto 生成 |
| 13 | 路由级网关策略与 Kustomize 后置渲染 | 渲染结果逐项对比 |
| 14 | 标准注册表分发 | 方案包通过 npm、pip 与 Helm 锁定安装 |
| 7 | 上游收敛 | 随上游版本，站点回归通过后删除补丁 |

各阶段为独立 PR，不改变执行授权、会话隔离与审批语义。

### 验收

- PR 与 release PR 合并前通过检查；GitLab 作业不依赖宿主机状态。
- 工具访问规则只有一个实现，Chart、Ansible 与运行时消费同一计划；values 模型只在 proto 中定义。
- 方案包不再下载 generic package，平台与方案包通过标准注册表和锁文件对齐版本。
- 签名密钥轮换后认证正常；模型请求的授权不依赖 kagent 实时查询。
- `runtime/` 补丁只保留尚未进入上游的部分，并记录对应 issue、PR 与验证状态。

## 不在本次范围

- 平台外的回归测评与配置 GitOps。
- 语音听写与实时通话的转写链路合并，语音为可选组件。
- 读模型轮询：kagent 未提供全局任务变更流。
- 凭据保管由部署机迁移至专用密钥服务。
- GitLab Premium 功能：拉取镜像与外部仓库 CI。

## 参考

- [GitHub：受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)与[服务容器](https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services/about-service-containers)
- [GitLab Runner executor](https://docs.gitlab.com/runner/executors/)、[仓库镜像](https://docs.gitlab.com/user/project/repository/mirror/)、[npm](https://docs.gitlab.com/user/packages/npm_registry/) 与 [PyPI](https://docs.gitlab.com/user/packages/pypi_repository/) 包注册表
- [Kubernetes TokenReview](https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-review-v1/)
- [Helm post-rendering](https://helm.sh/docs/topics/advanced/#post-rendering)、[knip](https://knip.dev)
- [pg-boss](https://github.com/timgit/pg-boss)、[release-please](https://github.com/googleapis/release-please)、[helm-unittest](https://github.com/helm-unittest/helm-unittest)、[Conftest](https://www.conftest.dev/)
