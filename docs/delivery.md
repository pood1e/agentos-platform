# 构建与部署

参考部署通过 Ansible collection 在支持 KVM 的 Ubuntu 主机安装单节点 K3s、运行时、网关与平台 Chart。
工具版本由 [mise.toml](../mise.toml) / [mise.lock](../mise.lock) 固定，上游版本与运行时镜像摘要见 [deploy/vars.yaml](../deploy/vars.yaml)，运行时镜像由 kagent 与 Substrate fork 发布，Helm 使用仓库锁定的 4.x 版本。

## 安装与升级

站点 inventory 与变量保存在仓库外，`agentos` 组包含一台主机，主机名作为 Kubernetes 节点名：

```yaml
all:
  children:
    agentos:
      hosts:
        agentos-01: {ansible_host: 192.0.2.10, ansible_user: admin}
```

从已审阅发布记录取得版本、源码提交与 OCI 地址，使用站点信任的公钥安装 collection：

```sh
collection="$REGISTRY/collections/platform"
digest=$(oras resolve "$collection:$VERSION")
cosign verify --key /etc/agentos/cosign.pub --insecure-ignore-tlog \
  -a "version=$VERSION" -a "revision=$REVISION" "$collection@$digest"
oras pull "$collection@$digest" --output .cache/delivery
ansible-galaxy collection install ".cache/delivery/agentos-platform-$VERSION.tar.gz"
ansible-playbook agentos.platform.install -i <site>/inventory.yaml -e @<site>/vars.yaml
```

控制端安装 collection 内 `playbooks/deploy/requirements.txt` 的 Python 依赖，并提供 Helm、cosign、ORAS 与 Kustomize。
升级安装新版已验签 collection 后执行同一 playbook。运行时使用官方 Chart，资源调整经 Helm 4 `postrenderer/v1` 插件与 Kustomize overlay 应用。

| 站点变量 | 内容 |
| --- | --- |
| `agentos_domain` | 控制台域名，DNS / 证书覆盖该域及通配子域 |
| `agentos_image_registry` | 平台镜像注册表路径，即构建时 `$CI_REGISTRY_IMAGE` |
| `dns_zone` | Cloudflare DNS 区域，用于记录与 ACME DNS-01 |
| `app_chart_repository` | 应用 OCI Chart 仓库 |
| `app_chart`、`app_chart_version` | 应用 Chart 与版本，默认同版本平台 Chart；业务部署选择方案 Chart |
| `app_chart_revision`、`app_chart_public_key` | 应用源码提交与签名公钥，平台默认取 collection 固化值 |
| `delivery_version`、`delivery_revision`、`delivery_public_key` | collection 固化的平台版本、源码提交与可信公钥 |
| `app_values` | 应用 Chart 值，方案 Chart 的平台配置位于 `app_values.agentos` |
| `app_release_name`、`agentos_namespace` | release 与命名空间，均默认 `agentos` |
| `agentos_cache` | 缓存目录，默认 `$XDG_CACHE_HOME/agentos` 或 `~/.cache/agentos` |
| `node_hosts` | 可选节点 hosts 记录 `{name, address}` |

| 凭据输入 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` / `cloudflare_token_file` | DNS 与 ACME 凭据 |
| `model_key_file` | 首次创建 `model-credentials` 的模型 API Key |
| `identity_client_secret_file` | 站点 OIDC 机密客户端密钥，写入 `identity.secretRef` |
| `skill_repository_credential_file` | 可选 JSON，含只读 Git 仓库 `Authorization` 请求头 |
| `registry_config_file` | Docker JSON，用于制品下载、验签与镜像拉取 |

凭据文件使用 0600 权限，保存在仓库外或 `.cache/`。Helm values 通过 JSON 文件传入。

## 路由与身份

平台通过 HTTPRoute 暴露 console、API 与可选 MCP App 沙箱，Gateway 由站点提供：

```yaml
route:
  parentRefs: [{name: agentos-public, sectionName: https}]
  hosts: {console: agentos.example.com, api: api.agentos.example.com, sandbox: apps.agentos.example.com}
  from: [...]  # 站点 Gateway Pod 的 NetworkPolicy peer
```

参考部署启用 K3s Traefik 的 Gateway API，创建 `agentos-public` 与域名证书。
web 通过 oauth2-proxy 管理登录会话，向 API 注入访问令牌；CLI 等客户端直接以 Bearer 访问 API。

身份源由站点提供，平台只接入 OIDC：

```yaml
identity:
  issuer: https://identity.example.com/realms/operations
  clientId: agentos-console
  audience: agentos-platform
  writerRole: operations-writer
  secretRef: agentos-identity
  returnOrigins: [https://controller.example.com]
```

机密客户端登记 `https://<console>/oauth2/callback` 与 `https://<api>/delegation/callback`，支持授权码、PKCE 与 `offline_access`。
访问令牌的 `aud` 包含 `audience`，`roles` 声明携带 `writerRole` 与应用角色；`identity.secretRef` 的 `client-secret` 保存客户端密钥。
参考部署由 `identity_client_secret_file` 创建该 Secret，并首次生成 `<release>-sessions`，升级复用。
`returnOrigins` 登记 console 之外的委派返回源。console 自动发起离线授权，其他客户端使用 `GetAccessProfile.delegation_url`。
应用角色映射由发布包 `authorization.json` 描述，权限和凭据生命周期见[执行授权](execution-authorization.md)。

站点创建 `execution.keySecret`（默认 `agentos-execution`），`key` 为 Base64 编码的 32 字节密钥。
执行数据库、加密密钥、身份和会话 Secret 一并备份。
api 与 dataplane 使用同一镜像及独立 ServiceAccount / NetworkPolicy；dataplane 至少两副本并配置 PDB。

## 模型连接

`gateway.models` 声明预置模型连接，`modelConfig.spec` 提供默认对话模型参数。
团队知识与 `memory` Harness 使用站点提供的 `knowledge-embedding` 嵌入连接，模型需支持 768 维输出。
覆盖列表时保留 `default-model-config`：

```yaml
gateway:
  models:
    - name: default-model-config
      spec:
        provider: OpenAI
        match: {model: gpt-6.1-sol}
        baseURL: https://api.openai.com/v1
        policies: {auth: {secretRef: {name: model-credentials, key: api-key}}}
    - name: knowledge-embedding
      spec:
        provider: Ollama
        match: {model: embeddinggemma:300m}
        baseURL: http://embedding.example.internal:11434/v1
```

未配置嵌入连接时团队知识与记忆不可用。更换嵌入模型后，已有知识需清空后重新写入。

## 方案 Harness

方案可继承 kagent fork 发布的 Harness 基础镜像，由自身 CI 发布并固定摘要。`defaultHarness` 选择系统助手与新建 Agent 的默认配置，Agent 以 `spec.harnessRef.name` 独立选择：

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

配置复用原生 CRD schema，支持 kagent、Claude、Codex 与 BYO。自定义镜像实现对应运行协议、健康检查与持久化目录契约；私有镜像凭据来自站点 `registry_config_file`。

## 遥测

平台 OpenTelemetry 默认关闭。Chart 的 `telemetry.metrics` 显式配置 OTLP 端点后启用官方 Node SDK：

```yaml
telemetry:
  metrics:
    endpoint: https://otlp.example.com/v1/metrics
    protocol: http/protobuf
```

本地或镜像直启使用 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`，协议为 `grpc` 或 `http/protobuf`。
`OTEL_SDK_DISABLED=true` / `OTEL_METRICS_EXPORTER=none` 关闭采集；默认导出超时 1 秒，可用 `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` 调整毫秒值。
指标覆盖 HTTP / RPC 时延和进程资源，服务名为 `agentos-api` 与 `agentos-dataplane`。

kagent 使用原生 `TelemetryConfig`，站点变量 `kagent_telemetry` 应用于控制面和运行时默认值：

```yaml
kagent_telemetry:
  traces: {endpoint: 'https://otlp.example.com:4317', protocol: grpc, timeout: 5s}
  metrics: {endpoint: 'https://otlp.example.com/v1/metrics', protocol: http/protobuf}
  logs: {endpoint: 'https://otlp.example.com/v1/logs', protocol: http/protobuf}
```

各信号按配置启用，内容与原始请求体采集默认关闭，分别由 `captureContent` / `captureRawApiBodies` 控制。
Collector 与遥测存储由站点提供。语音独立可选，见[语音配置](speech.md)。

## 运行验证

任务持久化、HITL 与委派续接由 kagent 管理。控制台通过原生 API 查询任务与会话。

部署标签 `node`、`runtime`、`model`、`ingress`、`app` 支持分项执行，应用更新用 `--tags app`。
自管 DNS / TLS 的站点提供 Gateway 与 `agentos-ingress` Secret，跳过 `ingress`。
节点就绪后，`deploy/validate.yaml` 进行服务端 dry-run；节点上的 `python3 deploy/verify-runtime.py <namespace>` 验证原生沙箱执行与挂起恢复。

## 构建与发布

[GitHub Verify](../.github/workflows/verify.yaml) 提供合并门禁，`Required checks` 汇总结果；文档变更跳过代码检查，运行时和语音按变更范围验证，手动运行执行全量校验。
[GitLab CI](../.gitlab-ci.yml) 构建、打包和发布制品：

| 作业 | 范围 |
| --- | --- |
| `verify`、`python-verify` | 生成、构建、静态检查与单元测试，数据库使用 PostgreSQL 服务容器 |
| `deployment-check` | Ansible、Helm 单测与渲染、Conftest、kubeconform、后置渲染器 |
| `controller-verify`、`substrate-verify` | 固定 fork 源码 / Substrate 修复的原生 race、lint 与构建 |
| `platform-controller-verify` | 平台控制器 race、真实 API Server 回归与 vet |
| `build-*`、`voice-verify` | rootless BuildKit 镜像、Node / Python 契约与按范围触发的语音验证 |
| `package-check`、`release` | 校验源码提交，打包四个 Chart 与 collection，发布并签名不可变摘要 |

release-please 依据 Conventional Commits 维护版本 PR、变更记录和 tag，发布 PR 使用同一合并门禁。
GitLab `GitHub source sync` 定时快进同步 main 与 tag，使用限定 `source-sync` 环境的文件变量 `AGENTOS_SOURCE_MIRROR_KEY` / `AGENTOS_SOURCE_MIRROR_HOST_KEYS`。
开发版由固定 `bootstrap-sha` 计数和源码摘要生成，正式版由受保护 tag 发布；同提交重复构建保持版本一致。

| 制品 | 注册表与源码标识 |
| --- | --- |
| 镜像 | `$CI_REGISTRY_IMAGE[/组件]@sha256:…`，OCI `org.opencontainers.image.revision` |
| Chart | `oci://$CI_REGISTRY_IMAGE/charts/{agentos,agentos-controller,agentos-environment,agentos-connections}`，annotation 记录 revision |
| Node / Python 契约 | 项目 npm / PyPI 注册表，分别用 `gitHead` / wheel `Project-URL: Source` 记录源码 |
| Ansible collection | `$CI_REGISTRY_IMAGE/collections/platform`，归档与 OCI annotation 记录版本 / revision |

所有平台镜像从同一提交构建。打包替换镜像摘要并携带精确 `Chart.lock`，发布任务串行校验版本冲突，以 cosign 签名镜像、Chart 和 collection。
安装验证摘要及签名中的 `version` / `revision`，Chart 渲染后复验平台镜像。CI 镜像与工具来源见 [`ci/images/Dockerfile`](../ci/images/Dockerfile)和 [`ci/toolchain.gitlab-ci.yml`](../ci/toolchain.gitlab-ci.yml)。

| CI 变量 | 内容 |
| --- | --- |
| `AGENTOS_CI_RUNNER`、`AGENTOS_GO_RUNNER` | 普通与 Go runner，默认 `agentos-container` / `agentos-compiler` |
| `AGENTOS_PLATFORM_REGISTRY` | 平台制品注册表路径，CI 工具镜像由此拉取 |
| `AGENTOS_VOICE_RUNNER`、`AGENTOS_BUILDKIT_RUNNER` | 语音指令集与 rootless BuildKit runner |
| `AGENTOS_BUILDKIT_IMAGE`、`AGENTOS_REGISTRY_MIRROR` | BuildKit 摘要与可选 Docker Hub 镜像源 |
| `COSIGN_PRIVATE_KEY`、`COSIGN_PASSWORD` | 受保护的签名私钥文件与隐藏密码 |

SDK 通过标准包管理器消费：npm 配置项目 scope 注册表与原生令牌，Python 使用项目 PyPI 索引；锁文件固定版本和完整性。
Chart 与交付校验入口为 `ci/check-charts.sh` 和 `ci/test-artifacts.py`，真实组件验证见 [tests/proofs](../tests/proofs/README.md)。
