# 维护面收敛重构

状态：实施中。目标：平台 0.27.0。基线：平台 0.26.5（`40e4bc1`），AIOps 方案包 1.23.4。
范围：测评移出平台；以组件原生能力替换平台自研的后台协调、机器身份、环境发布与交付校验；收敛上游补丁。执行授权、会话隔离与审批语义不变。

## 现状

| 环节 | 现状 | 问题 |
| --- | --- | --- |
| 测评 | 候选快照、带前缀的隔离副本、评测 Job 回调、门禁与发布；服务端约 3100 行，另有前端页面与 Python 作业 | 默认关闭且站点未启用；依赖平台内部实现，维护面最大 |
| 观测 Web | 按 `upstream.json` 的字节偏移替换 Langfuse 打包产物中的 NextAuth 会话函数，访客共享预置账号 | 上游构建变化即导致镜像构建失败；访问不区分用户 |
| 后台协调 | 审批协调每 2 秒扫描全部任务，完成与错误状态保存在进程内 LRU；续接与角色对齐各自实现重试 | 重启后全量重扫；重试与节流逻辑分散 |
| 机器身份 | 平台按角色签发静态 API key，写入网关 key ConfigMap 并按角色生成 RemoteMCPServer；平台网关按 7 类 `apiKey.service` 授权 | 长期静态凭据；环境路由已使用 Actor JWT 与发现令牌，平台内路由仍为另一套认证 |
| 执行授权 | `authorization/` 的 OpenFGA 模型与 `server/authorization/policy.ts` 仅用于测试，运行时由 `executions.ts` 校验委派链 | 两套授权实现并存 |
| 环境套件 | Ansible 渲染 Jinja2 清单后直接应用；删除身份依赖手写清理任务 | 无版本化制品、回滚与资源回收 |
| 交付 | `ci/check-chart.py` 以 288 行断言校验渲染结果；每个 PR 手工提升版本；Cloudflare 记录由自写脚本维护 | 断言难以维护；并行开发时版本冲突 |
| 运行时补丁 | kagent `platform.patch` 2420 行（52 个文件）；Substrate `golden-skills.patch` 5659 行 | 每次上游升级需重新适配；Substrate 补丁主体已进入上游发布 |
| 依赖 | `d3-dag`、`parse5`、`entities` 无引用 | 无效升级与审计负担 |

## 原则

- 平台保留运行、协作、治理、控制台与环境接入，测评移出平台。
- 优先使用组件原生能力，不新增常驻基础设施服务。
- 通用改动提交上游，平台补丁随上游版本删除。

## 设计

### 测评移出平台

删除测评的服务、页面、契约、作业镜像、Chart 资源与部署变量：`server/evaluation`、`shared/evaluation.ts`、`src/features/evaluation`、
`proto/agentos/evaluation/v1`、`evaluation/`、`charts/agentos/templates/evaluation-*.yaml`、平台网关中 `evaluator`、`evaluation`、`online-judge` 的授权、
`deploy/vars.yaml` 的 `agentos_evaluation_*`、kagent 的测评监听命名空间，以及 CI 的测评镜像与 wheel 发布。

权限目录删除 `CAPABILITY_EVALUATIONS_MANAGE`。案例自动化删除 `/evaluations` 回报入口、`evaluation_token_file` 与 `evaluations.completed` 事实。
控制台的配置修改直接写入工作空间，与未启用测评时一致。移除前的实现见 `40e4bc1`；平台外的回归测评不在本次范围。

### 观测 Web 使用官方镜像

删除 `runtime/langfuse` 与 `ci/langfuse.gitlab-ci.yml`，Langfuse Web 与 worker 使用同一发布版本，各自固定官方镜像摘要。

- 站点提供 OIDC 客户端时启用 Langfuse 通用 OIDC 登录（`AUTH_CUSTOM_*`），关闭用户名密码登录；`LANGFUSE_DEFAULT_ORG_ID/ROLE` 与
  `LANGFUSE_DEFAULT_PROJECT_ID/ROLE` 把首次登录的用户加入预置组织与项目。
- 未提供 OIDC 客户端时启用用户名密码登录，使用已初始化的 `LANGFUSE_INIT_USER_*` 运维账号。

页面访问需要登录，项目 API Key 与 OTel 采集不变。

### 后台协调使用持久任务队列

审批协调与续接改为 [pg-boss](https://github.com/timgit/pg-boss) 任务，使用平台执行数据库，不新增服务：

- 读模型变更时按交互与子任务入队，使用 `stately` 队列策略与稳定的 `singletonKey` 收敛待处理任务并约束同一键的并发。
- 每次启动从 kagent 加载未完成审批及待续接任务，补齐队列；变更处理进度在持久入队后确认，入队失败从未确认进度重放。删除独立的周期性全量扫描。
- 外部决定未出属于业务等待，使用延迟任务继续检查；调用错误由 pg-boss 退避重试，耗尽后进入死信队列并支持重放。等待时限与任务保留时间覆盖审批周期。
- 授权复验、准备执行、原生回复与结果回写保持现有顺序。原生回复沿用确定性 messageId；外部审批的创建、准备执行与结果回写按稳定业务引用幂等。
  在外部操作成功、队列尚未确认时崩溃，重放先核对原生状态及外部审批记录，再继续未完成步骤。
- pg-boss 管理重试、过期与任务认领；业务副作用的幂等由上述原生消息和审批接口保证。删除进程内 LRU、错误节流与续接重试表。
- kagent 原生状态仍是唯一事实来源，队列只保存待处理的引用。每次消费重新解析执行绑定与发起人授权，用户任务按原用户离线授权续期后执行 OBO。
- 续接在 kagent 子 Agent 嵌套 HITL 修复（[kagent #3244](https://github.com/kagent-dev/kagent/issues/3244)）后删除；角色对齐随机器身份迁移删除。

### 机器身份迁移到工作负载身份

平台网关全部路由沿用环境路由已采用的 JWT 认证，删除 `apiKeyAuthentication`：

| 调用方 | 凭据 | 授权依据 |
| --- | --- | --- |
| Agent 的模型请求 | Substrate 注入的 Actor JWT | Actor 对应的会话、Agent 模型配置与允许的模型 API |
| Agent 的协作 MCP 与平台工具请求 | Substrate 注入的 Actor JWT | Actor 对应的会话、Agent 与模板工具绑定 |
| kagent 控制器工具发现 | Kubernetes 绑定 ServiceAccount 令牌，audience `agentos-mcp-discovery` | 指定控制器 ServiceAccount，仅允许元数据发现方法 |
| 平台 API 的模型调用（知识嵌入、语音） | Kubernetes 绑定 ServiceAccount 令牌，使用模型入口专用 audience | 指定平台 ServiceAccount 与允许的模型 API |
| 环境侧案例自动化 | 来源环境 realm 的 client credentials 令牌 | 已登记的 issuer、audience、客户端 `azp` 与服务账号 `sub`，仅允许对应环境的自动化入口 |

JWT 校验包含 issuer、audience、有效期与调用方主体。Actor JWT 进一步核对当前 Actor UID、会话及执行绑定；发现、模型与自动化令牌按路由和方法分别授权。
模型请求通过 HTTP 授权校验模型配置和调用范围，MCP 请求通过 ExtMCP 校验工具绑定。Kubernetes 令牌使用投射卷并随轮换重新读取。

平台工作负载身份用于认证系统调用，用户执行权限由原发起人、执行绑定与委派链共同收窄。后台消费沿用原用户 OBO 和既有权限上限；
普通退出保留后台执行授权，撤销执行绑定后拒绝后续调用，离线授权失效或账号禁用后刷新被拒绝。未配置浏览器 OIDC 的现有模式保持可用。

删除 `machine-identities.ts` 的密钥签发、按角色生成的 RemoteMCPServer 与启动时的绑定对齐，以及 `gateway-keys.yaml` 和机器令牌 Secret。
每个平台服务只注册一个 RemoteMCPServer，工具调用继续由 ExtMCP 按 Agent 模板的工具绑定逐次授权。

### 执行授权单轨

删除 `authorization/` 的 OpenFGA 模型与模型测试、`server/authorization/policy.ts`、OpenFGA 集成测试、`@openfga/sdk`、`ci/tools.sh` 的 `fga` 与 `openfga`，
以及 `ci/verify-authorization.sh` 与对应 CI 作业。Keycloak 客户端策略移至 `tests/proofs`。执行授权保留 `executions.ts` 的委派链收窄与撤销；
逐资源业务 ACL 实施时再引入关系授权服务。

### 环境套件发布为 Helm Chart

`environments/templates` 转为 Helm Chart，随平台版本发布到 OCI 注册表，输入由 `values.schema.json` 校验：

- 目标环境中的环境网关与平台命名空间中的预置接入资源分属两个 release，Helm 负责各自清单内 Kubernetes 资源的增删与回滚。
- 每个对象具有单一管理方。预置接入资源由 release 管理；控制台创建的接入资源及可编辑的 AgentTemplate 由平台管理，与 release 使用独立对象名。
  Chart 升级保留平台管理的配置，模板工具绑定的初始化与解绑通过现有平台接口完成。
- 一次性接管时核对现有 release 清单、所有权元数据与 ownerReferences，移交管理关系，保持资源名称、选择器和引用稳定；验证升级与回退时的资源归属。
- 移除身份或环境时，先完成模板解绑及执行准入撤销，再通过目标原生 API 撤销身份客户端、权限与 API 令牌，最后由 release 升级或卸载回收 Kubernetes 资源。
- `retire-platform-identities.yaml` 中的资源删除由 Helm 接管；模板解绑与原生凭据撤销保留为显式生命周期步骤，替代现有的分散清理任务。
- Ansible 保留身份客户端与令牌交换配置、证书签发、凭据生成与撤销、平台绑定初始化与解绑及 Chart 安装。
- `ci/check-environments.py` 与 `ci/render-environments.yaml` 由 Chart 测试替代。

### 交付工具链

- 版本：[release-please](https://github.com/googleapis/release-please) 依据 Conventional Commits 维护 `package.json`、各 Chart 版本与变更记录，功能 PR 不修改版本。
  GitHub 主仓库维护 release PR 与 tag，GitLab 发布流水线核对相同 tag 与提交 SHA。正式版本由指向 release 提交的受保护 tag 触发，其他 main 提交发布开发制品。
  发布任务按版本串行执行；重试核对已发布清单的提交与摘要，一致时复用，冲突时失败。

  | 制品 | 正式版本示例 | 开发版本示例 |
  | --- | --- | --- |
  | npm 契约与 Helm Chart（SemVer） | `0.27.0` | `0.27.0-dev.12.gabcdef123456` |
  | Python wheel（PEP 440） | `0.27.0` | `0.27.0.dev12+gabcdef123456` |

  开发序号由固定 `bootstrap-sha` 基线后的提交计数确定，同一提交的版本映射保持稳定。映射集中在发布入口，制品清单记录各格式版本、同一提交与摘要，方案包按清单锁定。

- Chart 测试：[helm-unittest](https://github.com/helm-unittest/helm-unittest) 覆盖模板断言与非法 values，跨资源约束使用 [Conftest](https://www.conftest.dev/) 策略，
  保留 kubeconform；`ci/check-chart.py` 删除。
- DNS：`deploy/dns_record.py` 改用 `community.general.cloudflare_dns`。
- 依赖：删除 `d3-dag`、`parse5`、`entities`。

### 上游收敛

- kagent：`platform.patch` 按能力拆分为上游 PR，包括 MemoryService 的身份范围与单条删除、持久化接口的 Actor JWT、Claude 工具白名单与 PreToolUse、
  首次准备的出站策略。合入并发布后删除对应补丁。
- Substrate：kagent main 已依赖 kagent-dev/substrate v0.6.0，其中包含 [#2159](https://github.com/agent-substrate/substrate/pull/2159)。随 kagent 下一版本升级并删除该回移；
  恢复期间放行出站的修复提交上游。

上游收敛独立持续交付，以选定上游发布版本通过站点回归为补丁删除条件。0.27.0 保留仍需本地承载的补丁及续接能力，并记录对应 issue、PR 与验证状态。

## 契约与配置

| 对象 | 变更 |
| --- | --- |
| `proto/agentos/evaluation/v1` | 删除 |
| `proto/agentos/authorization/v1` 的 `Capability` | 删除 `CAPABILITY_EVALUATIONS_MANAGE`，保留编号 |
| `proto/agentos/automation/v1` 的 `AutomationConfig` | 删除 `evaluation_token_file`，保留编号 |
| 平台 Chart values | 删除 `evaluation`；机器令牌改为 JWT 认证 |
| 部署变量 | 删除 `agentos_evaluation_*` 与 `langfuse_web_image_tag`；新增可选的 Langfuse OIDC 客户端变量 |
| 发布清单 | 关联提交、SemVer 版本、PEP 440 版本与制品摘要 |
| 方案包 | 删除测评 wheel 固定与测评角色；环境接入改用环境 Chart |

## 进度

- 阶段 1：PR #75 已合入。371 项 PostgreSQL 测试、88 项浏览器测试、13 项 Python 测试及部署校验通过。
- 阶段 2：PR #76。发布清单、双版本映射、开发制品消费与不可变发布验证通过。
- 阶段 3：协调队列已实现。377 项 PostgreSQL 测试通过，包含多副本、启动恢复、死信重放与外部提交后故障恢复；浏览器回归中。

## 实施顺序

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 测评移出、观测 Web 官方镜像、OpenFGA 清理、未使用依赖、DNS 模块 | `npm run verify`、Playwright、Python 测试、Chart 与部署校验 |
| 2 | release-please 与发布脚本 | release tag 与提交绑定；开发版本的 npm、Chart、wheel 构建与消费；并发发布与重试 |
| 3 | pg-boss 后台协调 | 启动补偿、入队失败重放、多副本、死信恢复；外部副作用成功后崩溃与结束竞态 |
| 4 | 工作负载身份 | Actor 模型与 MCP 授权；发现令牌隔离、自动化客户端准入、令牌轮换、OBO 与无 OIDC 部署 |
| 5 | 环境套件 Chart | 清单对比与严格服务端 dry-run；所有权移交、控制台配置保留、模板解绑与外部凭据回收 |
| 6 | Chart 测试工具 | `check-chart.py` 断言逐项迁移 |

阶段 1–6 为 0.27.0 的交付范围，各阶段为独立 PR。AIOps 方案包在这六个阶段完成后一次升级。上游收敛按已验证的发布版本独立推进。

## 切换

1. 部署观测：官方 Langfuse Web 镜像，按站点配置 OIDC 或账号登录。
2. 部署平台与方案包新版本。
3. 一次性移交环境接入资源的 release 清单与所有权，由环境 Chart 接管；通过平台接口完成绑定调整。
4. 对移除的身份完成模板解绑与原生凭据撤销，验收新身份链路后清理旧机器令牌 Secret 与 key ConfigMap。

回退时重新部署 0.26.5、AIOps 1.23.4 及其环境套件，同步移交资源所有权，由目标版本部署流程重建所需机器凭据。

## 验收

- 平台不含测评代码、资源与权限，控制台配置修改直接生效。
- Langfuse 使用官方镜像：OIDC 站点以 SSO 登录并自动加入项目，其他站点以运维账号登录。
- 审批协调与续接通过启动补偿、入队失败重放及多副本验证；外部操作成功后崩溃可恢复，业务副作用幂等，死信可重放；独立的周期性全量扫描已删除。
- 平台网关按 JWT 主体、路由及方法授权；发现令牌调用工具与模型被拒绝，其他环境客户端无法调用自动化入口，Actor 模型与工具请求受配置和执行权限约束。
- 用户 OBO 保留原发起人及权限上限；只读用户写入被拒绝，普通退出及短期令牌过期后后台任务继续执行，执行撤销与离线授权失效后按上述规则拒绝后续操作；无 OIDC 部署可用。
- 平台网关的 `apiKeyAuthentication`、退役机器令牌 Secret 与 key ConfigMap 已删除，工作负载令牌轮换后调用正常。
- 环境接入以 Chart 发布，升级与回退保持单一资源所有权及控制台配置；删除身份或环境后模板引用解除、外部凭据撤销、release 资源回收。
- 功能 PR 不修改版本；正式版本由 release tag 触发并关联唯一提交；开发制品通过 npm、Helm、Python 安装验证，已发布版本保持不可变。
- `runtime/` 保留补丁记录对应上游 issue、PR 与验证状态，按已验证发布版本删除；0.27.0 的发布门禁为阶段 1–6。

## 不在本次范围

- 平台外的回归测评与配置 GitOps。
- 语音听写与实时通话的转写链路合并，语音为可选组件。
- 读模型轮询：kagent 未提供全局任务变更流。
- 凭据保管由部署机迁移至专用密钥服务。

## 参考

- [pg-boss](https://github.com/timgit/pg-boss)、[队列策略](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)与[任务重试及过期](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md)
- [Langfuse：认证与 SSO](https://langfuse.com/self-hosting/security/authentication-and-sso)与[自动授予组织和项目访问](https://langfuse.com/self-hosting/administration/automated-access-provisioning)
- [release-please](https://github.com/googleapis/release-please)、[helm-unittest](https://github.com/helm-unittest/helm-unittest)、[Conftest](https://www.conftest.dev/)
- [Python 版本规范（PEP 440）](https://packaging.python.org/en/latest/specifications/version-specifiers/)
- [community.general.cloudflare_dns](https://docs.ansible.com/ansible/latest/collections/community/general/cloudflare_dns_module.html)
