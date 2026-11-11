# 构建、发布与 Chart 配置

平台发布 Chart、镜像、契约与参考部署 collection，安装步骤与站点变量见[参考部署](../deploy/README.md)。
工具版本由 [mise.toml](../mise.toml) / [mise.lock](../mise.lock) 固定，Harness 默认镜像由 kagent fork 发布并在 Chart 值中按摘要固定。

## 路由与身份

平台通过 HTTPRoute 暴露 console、API 与可选 MCP App 沙箱，Gateway 由站点提供：

```yaml
route:
  parentRefs: [{name: agentos-public, sectionName: https}]
  hosts: {console: agentos.example.com, api: api.agentos.example.com, sandbox: apps.agentos.example.com}
  from: [...]  # 站点 Gateway Pod 的 NetworkPolicy peer
```

web 通过 oauth2-proxy 管理登录会话，向 API 注入访问令牌；CLI 等客户端直接以 Bearer 访问 API。

身份源由站点提供，平台只接入 OIDC：

```yaml
identity:
  issuer: https://identity.example.com/realms/operations
  clientId: agentos-console
  audience: agentos-platform
  writerRole: operations-writer
  secretRef: agentos-identity
  from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: keycloak}}
      podSelector: {matchLabels: {app: keycloak}}
```

机密客户端登记 `https://<console>/oauth2/callback`，支持授权码与 PKCE。
访问令牌的 `aud` 包含 `audience`，`roles` 声明携带 `writerRole` 与应用角色；`identity.secretRef` 的 `client-secret` 保存客户端密钥。
同一客户端开启 JWT Authorization Grant（RFC 7523），信任 kagent 断言签发方 `http://kagent-controller.<namespace>.svc.cluster.local:8083/delegation`，公钥位于签发方的 `/jwks.json`。
需要后台执行的用户以 IdP subject 关联该签发方；`identity.from` 指定读取公钥的 IdP Pod。
console 加载时自动登记后台委托，其他客户端以用户 Bearer 调用 `ConsoleService.RegisterDelegationCredential`。
应用角色目录由契约包的 `authorization.json` 描述，权限和凭据生命周期见[执行授权](execution-authorization.md)。

kagent 配置 OIDC AuthProvider、ScopeRule、断言授权与持久凭据加密 Secret；断言私钥 `kagent-delegation-assertion` 由安装器生成。kagent PostgreSQL 与密钥由站点统一备份。
api 与 dataplane 使用独立 ServiceAccount / NetworkPolicy；dataplane 提供 `8080` 业务 MCP，原生协作 MCP 直连 kagent。

## 多工作空间

每个工作空间使用独立 namespace、AgentOS release 与 kagent 实例。中心 release 的 `api.workspaces` 配置其他实例；自身实例由 Chart 自动加入目录。目标 release 的 `api.delegates` 授予中心 API ServiceAccount 资源访问和网关入口：

```yaml
# 中心 release
api:
  workspaces:
    - namespace: research
      release: agentos-research
      entryAgent: assistant
      harness: standard
      kagentURL: http://kagent-controller.research.svc.cluster.local:8083

# research release
api:
  delegates:
    - namespace: agentos
      release: agentos
```

两个 release 使用同一 OIDC 主体规范，并在各自原生授权存储中建立工作空间成员绑定。中心 API 从各实例的原生 `ListWorkspaces` 汇总当前用户可见目录；委托凭据登记到当前工作空间的 kagent 实例。
`runtime.actorIssuer` / `runtime.actorJWKS` 固定 Substrate 身份源；`runtime.kubernetesIssuer` 与集群签发方一致；`runtime.kubernetesJWKS` 使用原生 HTTPS Backend 匿名读取 Kubernetes 公钥端点。参考部署的 K3s 仅对 `/openid/v1/jwks` 开放匿名认证，并为其授予 `system:service-account-issuer-discovery` 只读权限。网关 origin 同步登记到 kagent `gatewayAudiences`。

## 模型连接

`gateway.models` 声明预置模型连接，`modelConfig.spec` 提供默认对话模型参数。
`memory` Harness 使用站点提供的 `knowledge-embedding` 嵌入连接，模型需支持 768 维输出。
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

未配置嵌入连接时 Agent 记忆不可用。更换嵌入模型后，已有记忆需清空后重新写入。

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

配置复用原生 CRD schema，支持 kagent、Claude、Codex 与 BYO。自定义镜像实现对应运行协议、健康检查与持久化目录契约；私有镜像使用站点提供的拉取凭据。

## 遥测

平台 OpenTelemetry 默认关闭。Chart 的 `telemetry.metrics` 显式配置 OTLP 端点后启用官方 Node SDK：

```yaml
telemetry:
  metrics:
    endpoint: https://otlp.example.com/v1/metrics
    protocol: http/protobuf
```

本地或镜像直启使用 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`，协议为 `grpc` 或 `http/protobuf`。
`OTEL_SDK_DISABLED=true` / `OTEL_METRICS_EXPORTER=none` 关闭采集。平台仅启用指标；导出与传输超时上限为 1 秒，`OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` 可指定更短的毫秒值。初始化、SDK 和退出故障各报告一次固定诊断，核心继续服务。
指标覆盖入站与出站 Connect RPC 时延和进程资源，服务名为 `agentos-api` 与 `agentos-dataplane`。
SDK 诊断级别遵循 `OTEL_LOG_LEVEL`，正文使用固定消息。核心启动、健康检查与关闭独立于导出状态。

kagent 使用原生 `TelemetryConfig`，Collector 与遥测存储由站点提供。语音独立可选，见[语音配置](speech.md)。

## 构建与发布

[GitHub Verify](../.github/workflows/verify.yaml) 提供合并门禁，`Required checks` 汇总结果；文档变更跳过代码检查，运行时、语音与参考部署按变更范围验证，手动运行执行全量校验。
[GitLab CI](../.gitlab-ci.yml) 构建、打包和发布制品：

| 作业 | 范围 |
| --- | --- |
| `verify`、`python-verify` | 生成、构建、静态检查与单元测试 |
| `deployment-check` | Helm 单测与渲染、Conftest、kubeconform、制品验签 |
| `platform-controller-verify` | 平台控制器 race、真实 API Server 回归与 vet |
| `build-*`、`voice-verify` | Docker Buildx 镜像、Node / Python 契约与按范围触发的语音验证 |
| `package-check`、`release` | 校验源码提交，打包四个 Chart 与参考部署 collection，发布并签名不可变摘要 |

release-please 依据 Conventional Commits 维护版本 PR、变更记录和 tag，发布 PR 使用同一合并门禁。
GitLab `GitHub source sync` 定时快进同步 main 与 tag，使用限定 `source-sync` 环境的文件变量 `AGENTOS_SOURCE_MIRROR_KEY` / `AGENTOS_SOURCE_MIRROR_HOST_KEYS`。
开发版由固定 `bootstrap-sha` 计数和源码摘要生成，正式版由受保护 tag 发布；同提交重复构建保持版本一致。

| 制品 | 注册表与源码标识 |
| --- | --- |
| 镜像 | `$CI_REGISTRY_IMAGE[/组件]@sha256:…`，OCI `org.opencontainers.image.revision` |
| Chart | `oci://$CI_REGISTRY_IMAGE/charts/{agentos,agentos-controller,agentos-environment,agentos-connections}`，annotation 记录 revision |
| 参考部署 collection | `$CI_REGISTRY_IMAGE/collections/platform:<版本>`，ORAS annotation 记录 version 与 revision |
| Node / Python 契约 | 项目 npm / PyPI 注册表，分别用 `gitHead` / wheel `Project-URL: Source` 记录源码；包含角色目录 `authorization.json` |

所有平台镜像从同一提交构建。打包替换镜像摘要并携带精确 `Chart.lock`；collection 写入同一提交的版本、镜像注册表、平台 Chart 默认值与公钥。发布任务串行校验版本冲突，以 cosign 签名镜像、Chart 与 collection，公钥为 [`ci/cosign.pub`](../ci/cosign.pub)。
部署方校验摘要及签名中的 `version` / `revision`，Chart 渲染后复验平台镜像。编译、测试与打包作业运行在 shell runner，工具链由 `mise.lock` 锁定，入口为 [`ci/toolchain.sh`](../ci/toolchain.sh)；镜像构建与语音验证运行在 Docker runner，使用 Docker Buildx 与注册表构建缓存。

| CI 变量 | 内容 |
| --- | --- |
| `AGENTOS_CI_RUNNER` | shell runner 标签，默认 `agentos-shell` |
| `AGENTOS_PACKAGE_RUNNER` | Docker runner 标签前缀，默认 `agentos-docker`；镜像在 `<前缀>-amd64`（需支持 AVX2）与 `<前缀>-arm64` runner 按架构原生构建，由 `build-index` 合并为同一提交标签的多架构镜像 |
| `COSIGN_PRIVATE_KEY`、`COSIGN_PASSWORD` | 受保护的签名私钥文件与隐藏密码 |

契约包包含 proto、生成绑定、schema 与角色目录。Node 导出路径为 `gen/*`、`gen/schema/*`、`proto/*`、`third_party/*` 和 `authorization.json`，运行时依赖为官方 Protobuf 库。消费者通过 Kubernetes 官方客户端读取 `AccessPlan.status.targets` 的工具决策，同时校验 status 和 `Ready=True` condition 的 `observedGeneration` 与资源代际一致。

契约通过标准包管理器消费：npm 配置项目 scope 注册表与原生令牌，Python 使用项目 PyPI 索引；锁文件固定版本和完整性。
Chart 与交付校验入口为 `ci/check-charts.sh` 和 `ci/test-artifacts.py`，参考部署校验入口为 `ci/check-collection.sh`，真实组件验证见 [tests/proofs](../tests/proofs/README.md)。
