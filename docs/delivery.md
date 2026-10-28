# 构建、发布与 Chart 配置

平台发布 Chart、镜像与契约；参考部署由独立的站点发行版固定平台版本后签名发布，安装步骤与站点变量随发行版提供。
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
  returnOrigins: [https://controller.example.com]
```

机密客户端登记 `https://<console>/oauth2/callback` 与 `https://<api>/delegation/callback`，支持授权码、PKCE 与 `offline_access`。
访问令牌的 `aud` 包含 `audience`，`roles` 声明携带 `writerRole` 与应用角色；`identity.secretRef` 的 `client-secret` 保存客户端密钥。
`returnOrigins` 登记 console 之外的委派返回源。console 自动发起离线授权，其他客户端使用 `GetAccessProfile.delegation_url`。
应用角色目录由契约包的 `authorization.json` 描述，权限和凭据生命周期见[执行授权](execution-authorization.md)。

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
`OTEL_SDK_DISABLED=true` / `OTEL_METRICS_EXPORTER=none` 关闭采集；默认导出超时 1 秒，可用 `OTEL_EXPORTER_OTLP_METRICS_TIMEOUT` 调整毫秒值。
指标覆盖 HTTP / RPC 时延和进程资源，服务名为 `agentos-api` 与 `agentos-dataplane`。

kagent 使用原生 `TelemetryConfig`，Collector 与遥测存储由站点提供。语音独立可选，见[语音配置](speech.md)。

## 构建与发布

[GitHub Verify](../.github/workflows/verify.yaml) 提供合并门禁，`Required checks` 汇总结果；文档变更跳过代码检查，运行时和语音按变更范围验证，手动运行执行全量校验。
[GitLab CI](../.gitlab-ci.yml) 构建、打包和发布制品：

| 作业 | 范围 |
| --- | --- |
| `verify`、`python-verify` | 生成、构建、静态检查与单元测试，数据库使用 PostgreSQL 服务容器 |
| `deployment-check` | Helm 单测与渲染、Conftest、kubeconform、制品验签 |
| `platform-controller-verify` | 平台控制器 race、真实 API Server 回归与 vet |
| `build-*`、`voice-verify` | rootless BuildKit 镜像、Node / Python 契约与按范围触发的语音验证 |
| `package-check`、`release` | 校验源码提交，打包四个 Chart，发布并签名不可变摘要 |

release-please 依据 Conventional Commits 维护版本 PR、变更记录和 tag，发布 PR 使用同一合并门禁。
GitLab `GitHub source sync` 定时快进同步 main 与 tag，使用限定 `source-sync` 环境的文件变量 `AGENTOS_SOURCE_MIRROR_KEY` / `AGENTOS_SOURCE_MIRROR_HOST_KEYS`。
开发版由固定 `bootstrap-sha` 计数和源码摘要生成，正式版由受保护 tag 发布；同提交重复构建保持版本一致。

| 制品 | 注册表与源码标识 |
| --- | --- |
| 镜像 | `$CI_REGISTRY_IMAGE[/组件]@sha256:…`，OCI `org.opencontainers.image.revision` |
| Chart | `oci://$CI_REGISTRY_IMAGE/charts/{agentos,agentos-controller,agentos-environment,agentos-connections}`，annotation 记录 revision |
| Node / Python 契约 | 项目 npm / PyPI 注册表，分别用 `gitHead` / wheel `Project-URL: Source` 记录源码；包含角色目录 `authorization.json` |

所有平台镜像从同一提交构建。打包替换镜像摘要并携带精确 `Chart.lock`，发布任务串行校验版本冲突，以 cosign 签名镜像与 Chart，公钥为 [`ci/cosign.pub`](../ci/cosign.pub)。
部署方校验摘要及签名中的 `version` / `revision`，Chart 渲染后复验平台镜像。CI 镜像与工具来源见 [`ci/images/Dockerfile`](../ci/images/Dockerfile)和 [`ci/toolchain.gitlab-ci.yml`](../ci/toolchain.gitlab-ci.yml)。

| CI 变量 | 内容 |
| --- | --- |
| `AGENTOS_CI_RUNNER`、`AGENTOS_GO_RUNNER` | 普通与 Go runner，默认 `agentos-container` / `agentos-compiler` |
| `AGENTOS_PLATFORM_REGISTRY` | 平台制品注册表路径，CI 工具镜像由此拉取 |
| `AGENTOS_VOICE_RUNNER`、`AGENTOS_BUILDKIT_RUNNER` | 语音指令集与 rootless BuildKit runner |
| `AGENTOS_BUILDKIT_IMAGE`、`AGENTOS_REGISTRY_MIRROR` | BuildKit 摘要与可选 Docker Hub 镜像源 |
| `COSIGN_PRIVATE_KEY`、`COSIGN_PASSWORD` | 受保护的签名私钥文件与隐藏密码 |

SDK 通过标准包管理器消费：npm 配置项目 scope 注册表与原生令牌，Python 使用项目 PyPI 索引；锁文件固定版本和完整性。
Chart 与交付校验入口为 `ci/check-charts.sh` 和 `ci/test-artifacts.py`，真实组件验证见 [tests/proofs](../tests/proofs/README.md)。
