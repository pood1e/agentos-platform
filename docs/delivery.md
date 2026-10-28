# 构建与部署

## 构建与发布

GitLab CI 入口为 [`.gitlab-ci.yml`](../.gitlab-ci.yml)，运行时作业见 [`ci/runtime.gitlab-ci.yml`](../ci/runtime.gitlab-ci.yml)，镜像构建模板见
[`ci/build.gitlab-ci.yml`](../ci/build.gitlab-ci.yml)。

| 作业 | 内容 |
| --- | --- |
| `verify` | 生成、构建、Biome / buf lint / tsc / Knip 与单元测试；PostgreSQL 使用独立服务容器 |
| `deployment-check` | ansible-lint 与语法检查；平台 Chart 和[示例方案 Chart](../tests/fixtures/solution-chart) 的渲染断言、kubeconform 严格校验与 post-renderer 测试；环境套件的渲染断言与 kubeconform 校验 |
| `python-verify` | 生成 Python 契约；ruff 检查与格式校验 |
| `controller-verify`、`substrate-verify` | 对固定上游源码应用 `runtime/` 补丁，执行 race 测试、lint 并编译；每次发布均从当前提交构建 |
| `platform-controller-verify` | 平台控制器 race、真实 API Server 集成测试、vet 与编译 |
| `build-*` | rootless BuildKit 构建平台 API、web、平台控制器、kagent、Substrate、Harness 与语音镜像，写入源码提交标签 |
| `build-contracts` | 提前构建 Node SDK 与 Python protobuf wheel，并验证发布打包 |
| `voice-verify` | 语音、协议或相关依赖变更时，在本次构建的语音镜像中校验源码与单元测试；tag、手动及完整定时流水线执行全量校验 |
| `package-check` | 校验所有平台镜像的源码提交，打包四个 Chart 与参考部署 collection；功能分支同样执行 |
| `release` | 发布原生 npm / PyPI 契约；推送 OCI Chart 与 collection，以 cosign 签名镜像、Chart 和 collection 的不可变摘要；main 发布开发版，受保护的版本 tag 发布正式版 |

GitHub 的 [Verify 工作流](../.github/workflows/verify.yaml) 在合并前执行应用、部署、Python、平台控制器与运行时检查，`Required checks` 汇总必需结果；纯文档变更跳过无关检查。平台控制器与部署检查并行，语音校验按代码、协议和依赖变更触发；手动运行执行完整校验。平台控制器和运行时变更合入 main 后更新默认分支的 Go 缓存，后续 PR 通过原生缓存复用。GitLab 的应用构建、协议打包和部署检查同样缓存 Go 模块及编译结果。
release-please 使用仓库令牌管理发布 PR。创建后，同一作业通过 GitHub 原生审批 API 启动同仓库、release-please 分支的检查；普通 PR 与发布 PR 均在合并提交执行相同门禁。

GitHub 的 release-please 根据 Conventional Commits 更新发布 PR、变更记录、npm 与 Chart 版本。版本文件由发布 PR 集中维护。
同仓库 library Chart 依赖由当前源码解析；发布包携带精确版本的 `Chart.lock`。
合并发布 PR 后生成版本 tag，GitLab 的 `GitHub source sync` 定时流水线从内网同步 main 与 tag；GitLab 核对 tag、源提交和版本一致性后构建。
同步使用项目专用部署密钥，存于受保护的文件变量 `AGENTOS_SOURCE_MIRROR_KEY`，主机公钥存于 `AGENTOS_SOURCE_MIRROR_HOST_KEYS`；两者限定 `source-sync` 环境。同步对 main 执行快进更新，维持已发布 tag 与提交的绑定；GitLab 原生推送触发对应构建流水线。

开发版本从固定的 `bootstrap-sha` 计数，与提交摘要组成 npm/Chart 的 SemVer 和 Python 的 PEP 440 版本，同一提交重复构建保持一致。
制品使用各自的原生注册表和元数据：

| 制品 | 地址与源码标识 |
| --- | --- |
| 镜像 | `$CI_REGISTRY_IMAGE[/组件]@sha256:…`，OCI `org.opencontainers.image.revision` 标签 |
| Helm Chart | `oci://$CI_REGISTRY_IMAGE/charts/{agentos,agentos-controller,agentos-environment,agentos-connections}`，Chart annotation 记录源码提交 |
| npm 契约 | GitLab 项目 npm 注册表，`@agentos/contracts` 的 `gitHead` 记录源码提交 |
| Python 契约 | GitLab 项目 PyPI 注册表，`agentos-contracts` 的 wheel `Project-URL: Source` 记录源码提交 |
| Ansible collection | `$CI_REGISTRY_IMAGE/collections/platform`，原生 collection 归档与 OCI annotation 记录版本和源码提交 |

发布任务串行执行。相同版本重试时核对现有包内容；冲突直接失败。Chart 与 collection 按源码提交时间规范化。
所有平台镜像都从同一提交构建，打包时将源码中的占位注册表与镜像摘要替换为本次构建结果。
安装前使用站点信任的公钥校验不可变 OCI 摘要，以及签名中的 `version`、`revision`；Chart 渲染后再次校验其中的平台镜像。

工具版本与来源校验由 `mise.toml`、`mise.lock` 管理；CI 镜像在 `ci/images/Dockerfile` 构建，消费者在 `ci/toolchain.gitlab-ci.yml` 固定其摘要。
PostgreSQL 使用原生服务容器，npm 与 Go 缓存由 CI 管理。镜像按自身路径使用资源锁，可并行构建；最终发布串行执行至完成。
发布 PR 的版本提交跳过重复的 main 构建，由正式 tag 完成发布。协议生成使用官方 protoc 与 Buf 插件。
工具链与参考部署固定 Helm 4.3.1。平台与环境共用 `agentos-kustomize` Helm 4 插件，上游 kagent / Substrate 的资源调整由 Kustomize overlay 完成。插件采用原生 `postrenderer/v1` 接口，模板和 hook 一并验证。


| CI/CD 变量 | 说明 |
| --- | --- |
| `AGENTOS_CI_RUNNER` | 普通 Docker executor 标签，默认 `agentos-container` |
| `AGENTOS_GO_RUNNER` | Go Docker executor 标签，默认 `agentos-compiler` |
| `AGENTOS_VOICE_RUNNER` | 支持原生语音库指令集的 Docker executor，默认 `agentos-avx2` |
| `AGENTOS_BUILDKIT_RUNNER` | rootless BuildKit 的 runner 标签 |
| `AGENTOS_BUILDKIT_IMAGE` | rootless BuildKit 镜像，按摘要固定 |
| `AGENTOS_REGISTRY_MIRROR` | 可选，BuildKit 使用的 Docker Hub 镜像源 |
| `COSIGN_PRIVATE_KEY` | 受保护的文件变量，保存发布签名私钥 |
| `COSIGN_PASSWORD` | 受保护、隐藏的签名密钥密码 |

## 后台协调

平台在执行数据库的 `agentos_jobs` schema 使用 pg-boss，队列按工作空间隔离。各进程在投影写入事务内入队，worker 消费并维护队列。
审批与续接采用 `stately` 策略和稳定业务键，调用错误退避重试 12 次后进入 `<namespace>.failed`，记录保留 90 天；外部决定未出使用延迟任务继续等待。

排查提供方故障或恢复授权后，在 worker 容器内先检查死信，再按原生引用重放：

```sh
node build/server/jobs/replay.js
node build/server/jobs/replay.js --execute <dead-letter-job-id>
```

未指定 ID 时每次最多处理 100 条；每次消费仍从原生状态解析执行身份与授权，仅重放仍具备有效执行授权的任务。

## 遥测

站点通过 `kagent_telemetry` 配置 kagent 控制面与 Agent 运行时的 OpenTelemetry 默认值，直接采用原生
[`TelemetryConfig`](https://github.com/pood1e/agentos-platform/blob/main/third_party/kagent/kagent/config/v1/config.proto)。`traces`、`metrics`、`logs` 分别启用对应信号，支持 OTLP/gRPC 和 OTLP/HTTP protobuf；各信号按显式配置导出。

```yaml
kagent_telemetry:
  traces:
    endpoint: https://otlp.example.com:4317
    protocol: grpc
    timeout: 5s
  metrics:
    endpoint: https://otlp.example.com/v1/metrics
    protocol: http/protobuf
  logs:
    endpoint: https://otlp.example.com/v1/logs
    protocol: http/protobuf
```

接收端及后端存储由站点提供，可接入 OpenTelemetry Collector 或兼容后端。Agent 的遥测出口由 kagent 原生编译器从配置推导。

消息内容和原始 API 请求体采集默认关闭，分别由原生 `captureContent` 与 `captureRawApiBodies` 控制。
部署变量应用于 `config.telemetry` 和 `config.runtimeDefaults.telemetry`，更新后由运行时部署流程生效。

平台遥测默认关闭，配置端点后使用 OpenTelemetry Node SDK 导出指标。平台 Chart 的 `telemetry.metrics` 配置 OTLP 出口，`protocol` 支持 `grpc` 与 `http/protobuf`：

```yaml
telemetry:
  metrics:
    endpoint: https://otlp.example.com/v1/metrics
    protocol: http/protobuf
```

镜像直启和本地开发使用 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 配置端点，协议使用原生 `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`。`OTEL_SDK_DISABLED=true` 或 `OTEL_METRICS_EXPORTER=none` 关闭遥测。未启用时使用官方 API 的空操作实现；接收端不可用时平台继续处理请求。
指标导出默认超时 1 秒，可通过 `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` 调整，单位为毫秒。

| 指标 | 内容 |
| --- | --- |
| `http.server.request.duration` | dataplane 的网关外部鉴权，按路由与状态码 |
| `rpc.server.call.duration` | dataplane 的 ExtMCP、TaskStore 与 Memory 代理，按方法与状态码 |
| `rpc.client.call.duration` | kagent 请求，按方法与状态码；计数即请求速率 |
| `process.memory.usage`、`process.cpu.time` | 各进程的内存与 CPU |

`service.name` 为 `agentos-api`、`agentos-dataplane`、`agentos-worker` 与 `agentos-identity`。

## 方案 Harness

平台发布通用 Harness 基础镜像与原生运行协议。方案包可继承基础镜像构建自己的运行镜像，由方案 CI 发布并在 Chart 中固定摘要。方案包通过 `agentos.harnesses` 声明原生 Harness，`defaultHarness` 指定系统助手与新建智能体的默认运行配置；各智能体通过 `spec.harnessRef.name` 独立选择。

```yaml
agentos:
  defaultHarness: operations
  harnesses:
    operations:
      kagent: {}
      workload:
        image: registry.example.com/team/operations@sha256:<digest>
      substrate:
        workerPoolRef: {name: kagent-default}
        snapshotPolicy: {location: 's3://ate-snapshots/kagent/'}
```

Harness 配置直接使用固定版本的原生 CRD schema，支持 kagent、Claude、Codex 及 BYO 运行时。镜像须实现相应运行时协议、健康检查与持久化目录约定；基于平台基础镜像扩展时保留这些契约。目标系统凭据由执行时授权与宿主网关注入。方案镜像与平台默认镜像分别发布，工作负载使用 Harness 明确配置的镜像。私有注册表凭据使用站点 `registry_config_file` 的 Docker 配置；运行时按其中的各注册表提供拉取凭据。

## 部署

参考部署为一台支持 KVM 的 Ubuntu 主机运行单节点 K3s。Ansible 管理节点、DNS、TLS、CNPG、agentgateway、Agent Substrate、kagent 与应用
Chart；Agent 在 Cloud Hypervisor microVM 中执行。上游版本与运行时镜像摘要固定在 [`deploy/vars.yaml`](../deploy/vars.yaml)。

站点清单与变量由仓库外的站点配置提供，部署时传入。清单的 `agentos` 组包含一台主机，主机名即 Kubernetes 节点名：

```yaml
all:
  children:
    agentos:
      hosts:
        agentos-01: {ansible_host: 192.0.2.10, ansible_user: admin}
```

| 站点变量 | 说明 |
| --- | --- |
| `agentos_domain` | 控制台域名；DNS 与证书同时覆盖 `*.<agentos_domain>`，供 API 与沙箱主机名使用 |
| `agentos_image_registry` | 平台运行时镜像所在的注册表路径，即构建时的 `$CI_REGISTRY_IMAGE` |
| `dns_zone` | Cloudflare 托管的 DNS 区域，用于域名记录与 ACME DNS-01 |
| `app_chart_repository` | 应用 Chart 所在的 OCI 仓库，如 `oci://registry.example.com/team/platform/charts` |
| `app_chart`、`app_chart_version` | 应用 Chart 名称与版本，默认平台 Chart `agentos` 与 collection 对应版本；方案部署填方案 Chart |
| `app_chart_revision`、`app_chart_public_key` | 方案 Chart 的源码提交与可信签名公钥；平台 Chart 默认使用 collection 对应值 |
| `delivery_version`、`delivery_revision` | 平台版本与源码提交，由发布的 collection 固化 |
| `delivery_public_key` | 平台签名公钥，默认使用已验签 collection 内的公钥 |
| `agentos_cache` | 部署缓存目录，默认 `$XDG_CACHE_HOME/agentos` 或 `~/.cache/agentos` |
| `app_release_name` | Helm 发布名称，默认 `agentos` |
| `app_values` | 应用 Chart 的值：`route`、模型、`global.agentos` 等 |
| `agentos_namespace` | 平台命名空间，默认 `agentos` |
| `node_hosts` | 可选，节点 `/etc/hosts` 追加的 `{name, address}` |

| 凭据 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `cloudflare_token_file` | DNS 记录与 ACME challenge |
| `model_key_file` | 首次创建模型 API Key Secret `model-credentials` |
| `skill_repository_credential_file` | 可选，JSON，含只读 Git 仓库的 `Authorization` 请求头，创建 `agentos-skill-repository` |
| `registry_config_file` | Docker JSON 同时供原生 OCI 下载、验签与 Kubernetes 镜像拉取使用 |

凭据文件权限为 0600，保存在仓库外或忽略的 `.cache/`。平台模型与 MCP 使用工作负载 JWT；目标系统凭据由运维环境管理。Helm values 以 JSON 文件传入，保留 JWK 的标准字段名。

平台以 Gateway API HTTPRoute 暴露 console（web）、平台 API 与可选的 MCP App 沙箱，Gateway 由站点提供：

```yaml
route:
  parentRefs: [{name: agentos-public, sectionName: https}]
  hosts: {console: agentos.example.com, api: api.agentos.example.com, sandbox: apps.agentos.example.com}
  from: [...]  # 站点网关 Pod 的 NetworkPolicy peer，默认 K3s 内置 Traefik
```

参考部署启用 K3s 内置 Traefik 的 Gateway API 支持，创建 Gateway `agentos-public` 与覆盖 `<agentos_domain>`、`*.<agentos_domain>` 的证书。
平台 API 只接受 Bearer 令牌；web 以 oauth2-proxy 持有浏览器会话并向 API 注入访问令牌，前端与平台 API 独立发布。CLI、Controller UI
等客户端直接以 Bearer 访问 API 主机。

身份源由 `identity.mode` 选择，默认 `password`：内置身份源随 Chart 部署于 `https://<console>/identity`，以 oidc-provider 签发标准令牌。
登录页只校验站点密码，令牌主体为单一共享用户并携带全部应用角色与写角色；连续输错密码按来源地址与全站限速。站点密码保存在
`identity.secretRef`（默认 `agentos-identity`）的 `password` 键。参考部署首次安装时创建站点密码、`<release>-identity-keys` 的签名、客户端与 Cookie 密钥，以及 `<release>-sessions` 的浏览器会话和委派密钥；升级复用已有 Secret，密钥随站点数据库备份。签名密钥由 `community.crypto` 生成 P-256 PKCS#8 PEM。启用外部身份提供方时配置：

```yaml
identity:
  mode: oidc
  issuer: https://identity.example.com/realms/operations
  clientId: agentos-console
  audience: agentos-platform
  writerRole: operations-writer
  secretRef: agentos-identity
  returnOrigins: [https://controller.example.com]
```

机密客户端登记回调 `https://<console>/oauth2/callback`（web 登录）与 `https://<api>/delegation/callback`（离线委派），引用的 Secret 包含 `client-secret`。`returnOrigins` 登记 console 之外允许完成委派后返回的前端源。
方案 Chart 的平台值位于 `app_values.agentos`。平台 API 校验访问令牌的 `iss`、`aud`、`exp`、`iat`、`sub` 与签名，`roles` 数组包含 `writerRole` 时授予写权限，其余认证用户可聊天和执行只读查询。API audience 与登录 clientId 分别配置，API 请求使用 API 受众的访问令牌。
后台执行使用用户的离线授权：console 登录后自动跳转平台 API 的 `/delegation/start` 完成授权，其他客户端向用户展示 `GetAccessProfile.delegation_url`。
RPC 使用官方 Protobuf `NO_SIDE_EFFECTS` 标记声明读取操作；认证用户可管理自己的对话、交互和取消，配置写操作分别要求智能体、Skill、MCP、团队知识、模型或 Harness 的应用角色；角色可组合，目录由发布包 `authorization.json` 提供。目标系统写角色仅决定运维操作上限。实际工具调用独立校验会话与 Agent 权限，见[执行授权](execution-authorization.md)。
执行授权复用 PostgreSQL 连接及 CA Secret。站点预先创建 `execution.keySecret`（默认 `agentos-execution`），其中 `key` 为 Base64 编码的 32 字节密钥；该 Secret 由站点与数据库一并备份。

平台进程使用同一镜像，副本数与资源由 `api`、`dataplane`、`worker` 分别配置。dataplane 至少两副本并配置 PodDisruptionBudget；worker 可多副本，对账实例由 PostgreSQL 会话锁选出。
各进程使用独立 ServiceAccount 与最小权限 Role；NetworkPolicy 放行站点网关与 web 访问 api，平台网关、网关控制器与 Substrate 出口访问 dataplane，worker 只发起出站连接。

参考部署从 OCI 安装 collection。版本与源码提交取自已审阅的发布记录，公钥通过站点可信渠道保存：

```sh
collection="$REGISTRY/collections/platform"
digest=$(oras resolve "$collection:$VERSION")
cosign verify --key /etc/agentos/cosign.pub --insecure-ignore-tlog \
  -a "version=$VERSION" -a "revision=$REVISION" "$collection@$digest"
oras pull "$collection@$digest" --output .cache/delivery
ansible-galaxy collection install ".cache/delivery/agentos-platform-$VERSION.tar.gz"
ansible-playbook agentos.platform.install -i <site>/inventory.yaml -e @<site>/vars.yaml
```

控制端需安装 collection 中 `playbooks/deploy/requirements.txt` 声明的 Python 依赖，并提供 Helm、cosign、ORAS 与 Kustomize。
升级使用新版本的已验签 collection，再执行同一 playbook；预置的更新与用户修改保留见[控制器](kubernetes-controller.md)。

契约通过标准包管理器消费。npm 在 `.npmrc` 中配置 scope 注册表与环境令牌，`package.json` 固定版本，`package-lock.json` 固定完整性：

```ini
@agentos:registry=https://gitlab.example.com/api/v4/projects/188/packages/npm/
//gitlab.example.com/api/v4/projects/188/packages/npm/:_authToken=${CI_JOB_TOKEN}
```

Python 使用项目的 `/packages/pypi/simple` 索引，锁文件固定 `agentos-contracts` 的 PEP 440 版本与 wheel SHA-256。
注册表认证采用 pip 的原生配置，禁用该项目的 PyPI 转发；依赖由站点统一索引或已安装的运行环境提供。
官方用法见 [GitLab npm](https://docs.gitlab.com/user/packages/npm_registry/)、[GitLab PyPI](https://docs.gitlab.com/user/packages/pypi_repository/)、
[Helm OCI](https://helm.sh/docs/topics/registries/) 与 [Ansible collection 安装](https://docs.ansible.com/projects/ansible/latest/collections_guide/collections_installing.html)。

标签 `node`、`runtime`、`model`、`ingress`、`app` 可单独执行；更新应用使用 `--tags app`。自主管理 DNS 与 TLS 的站点跳过 `ingress`，提供域名解析、
TLS Secret `agentos-ingress` 与 Gateway。站点密码可用 `kubectl -n <namespace> get secret agentos-identity -o jsonpath='{.data.password}' | base64 -d` 读取。节点就绪后，`deploy/validate.yaml` 以服务端 dry-run 校验 microVM 资源；在节点上执行
`python3 deploy/verify-runtime.py <namespace>` 创建一次 microVM 沙箱，核验执行、挂起恢复后的文件与 KVM 进程。

## 语音

ASR / TTS 服务、设置 Secret、听写与朗读、LiveKit 通话的配置见[语音](speech.md)。

## 发布校验

Chart 校验使用 `ci/check-charts.sh`：helm-unittest 覆盖模板与非法值，Conftest 覆盖跨资源、权限及部署配置约束，kubeconform 使用固定上游 CRD 验证。后置渲染器通过标准库 unittest 验证资源边界。
