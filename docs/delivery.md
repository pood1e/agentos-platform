# 构建与部署

## 构建与发布

GitLab CI 入口为 [`.gitlab-ci.yml`](../.gitlab-ci.yml)，运行时作业见 [`ci/runtime.gitlab-ci.yml`](../ci/runtime.gitlab-ci.yml)，镜像构建模板见
[`ci/build.gitlab-ci.yml`](../ci/build.gitlab-ci.yml)。

| 作业 | 内容 |
| --- | --- |
| `verify` | 生成、构建、Biome / buf lint / tsc / Knip 与单元测试；PostgreSQL 使用独立服务容器 |
| `deployment-check` | ansible-lint 与语法检查；平台 Chart 和[示例方案 Chart](../tests/fixtures/solution-chart) 的渲染断言、kubeconform 严格校验与 post-renderer 测试；环境套件的渲染断言与 kubeconform 校验 |
| `python-verify` | 生成 Python 契约；ruff 检查与格式校验；案例自动化的单元测试，案例工作流使用 Temporal 时间跳跃环境 |
| `controller-verify`、`substrate-verify` | 对固定上游源码应用 `runtime/` 补丁，执行 race 测试、lint 并编译；仅在运行时相关文件变更时触发 |
| `build-*` | rootless BuildKit 构建平台 API、web、kagent controller、Substrate、Harness 与案例自动化镜像，推送到 `$CI_REGISTRY_IMAGE` |
| `build-contracts` | 提前构建 Node SDK 与 Python protobuf wheel，并验证发布打包；不上传发布注册表 |
| `voice-verify` | 在本次构建的语音镜像中校验语音源码与单元测试 |
| `package-check` | 汇总候选镜像，核对运行时摘要与部署固定值，实际打包三个 Chart；功能分支同样执行 |
| `release` | 所有检查通过后，发布契约和部署包，打包带镜像摘要的平台 Chart，发布到 OCI 注册表，`dist/release.json` 记录各制品版本、源提交与摘要；main 发布开发版，受保护的版本 tag 发布正式版 |

GitHub 的 [Verify 工作流](../.github/workflows/verify.yaml) 在合并前执行应用、部署、Python、运行时与浏览器检查，`Required checks` 汇总必需结果；纯文档变更跳过无关检查。运行时变更合入 main 后更新默认分支的 Go 缓存，后续 PR 通过原生缓存复用。
release-please 使用仓库令牌管理发布 PR。创建后，同一作业通过 GitHub 原生审批 API 启动同仓库、release-please 分支的检查；普通 PR 与发布 PR 均在合并提交执行相同门禁。

GitHub 的 release-please 根据 Conventional Commits 更新发布 PR、变更记录、npm 与 Chart 版本。功能 PR 保持版本文件不变。
合并发布 PR 后生成版本 tag，GitLab 的 `GitHub source sync` 定时流水线从内网同步 main 与 tag；GitLab 核对 tag、源提交和版本一致性后构建。
同步使用项目专用部署密钥，存于受保护的文件变量 `AGENTOS_SOURCE_MIRROR_KEY`，主机公钥存于 `AGENTOS_SOURCE_MIRROR_HOST_KEYS`；两者限定 `source-sync` 环境。同步只做快进更新，拒绝覆盖已有版本 tag；GitLab 原生推送触发对应构建流水线。

开发版本从固定的 `bootstrap-sha` 计数，与提交摘要组成 npm/Chart 的 SemVer 和 Python 的 PEP 440 版本，同一提交重复构建保持一致。
Python、npm 契约与部署源码包位于 GitLab Generic Package `agentos-platform/<version>`；发布清单位于 `agentos-release/<version>/release.json`。
清单使用 `agentos.distribution.v1.ReleaseManifest`，包含源提交、两种格式的版本和各制品地址、SHA-256 摘要。
发布任务串行执行；重试复用一致的文件和 Chart，版本或摘要冲突直接失败。Chart 归档按源提交时间规范化，打包不会修改仓库中的值。

仓库内的镜像以摘要固定、注册表用占位符：Chart 值使用 `registry.example.com/agentos`，部署变量使用 `agentos_image_registry`。
工具版本与来源校验由 `mise.toml`、`mise.lock` 管理；CI 镜像在 `ci/images/Dockerfile` 构建，消费者在 `ci/toolchain.gitlab-ci.yml` 固定其摘要。
PostgreSQL 使用原生服务容器，npm 与 Go 缓存由 CI 管理。镜像按自身路径使用资源锁，可并行构建；最终发布串行执行且不被新提交取消。
发布 PR 的版本提交跳过重复的 main 构建，由正式 tag 完成发布。协议生成使用官方 protoc 与 Buf 插件。
发布时占位符替换为 `$CI_REGISTRY_IMAGE`。运行时镜像更新分两步：运行时作业构建出新摘要后，在 `deploy/vars.yaml` 与
`charts/agentos/values.yaml` 更新固定摘要；候选打包核对本次构建的摘要与固定值一致。正式 tag 复用已固定的运行时镜像，构建与根版本绑定的应用和契约制品；运行时检查与编译在源代码或工具链变更的分支检查中完成。

| CI/CD 变量 | 说明 |
| --- | --- |
| `AGENTOS_CI_RUNNER` | 普通 Docker executor 标签，默认 `agentos-container` |
| `AGENTOS_GO_RUNNER` | Go Docker executor 标签，默认 `agentos-compiler` |
| `AGENTOS_VOICE_RUNNER` | 支持原生语音库指令集的 Docker executor，默认 `agentos-avx2` |
| `AGENTOS_BUILDKIT_RUNNER` | rootless BuildKit 的 runner 标签 |
| `AGENTOS_BUILDKIT_IMAGE` | rootless BuildKit 镜像，按摘要固定 |
| `AGENTOS_REGISTRY_MIRROR` | 可选，BuildKit 使用的 Docker Hub 镜像源 |

## 后台协调

平台在执行数据库的 `agentos_jobs` schema 使用 pg-boss，队列按工作空间隔离。审批与续接采用 `stately` 策略和稳定业务键，
调用错误退避重试 12 次后进入 `<namespace>.failed`，记录保留 90 天；外部决定未出使用延迟任务继续等待。

排查提供方故障或恢复授权后，在平台容器内先检查死信，再按原生引用重放：

```sh
node build/server/jobs/replay.js
node build/server/jobs/replay.js --execute <dead-letter-job-id>
```

未指定 ID 时每次最多处理 100 条；每次消费仍从原生状态解析执行身份与授权，已取消的执行不会恢复。

## 遥测

站点通过 `kagent_telemetry` 配置 kagent 控制面与 Agent 运行时的 OpenTelemetry 默认值，直接采用原生
[`TelemetryConfig`](https://github.com/pood1e/agentos-platform/blob/main/third_party/kagent/kagent/config/v1/config.proto)。`traces`、`metrics`、`logs` 分别启用对应信号，支持 OTLP/gRPC 和 OTLP/HTTP protobuf；未配置的信号默认不导出。

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

站点清单与变量不入库，部署时传入。清单的 `agentos` 组包含一台主机，主机名即 Kubernetes 节点名：

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
| `app_chart`、`app_chart_version` | 应用 Chart 名称与版本，默认平台 Chart `agentos` 与仓库内版本；方案部署填方案 Chart |
| `app_release_name` | Helm 发布名称，默认 `agentos` |
| `app_values` | 应用 Chart 的值：`route`、模型、`global.agentos` 等 |
| `agentos_namespace` | 平台命名空间，默认 `agentos` |
| `node_hosts` | 可选，节点 `/etc/hosts` 追加的 `{name, address}` |

| 凭据 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `cloudflare_token_file` | DNS 记录与 ACME challenge |
| `registry_config_file` | Docker JSON，创建镜像拉取凭据 `agentos-registry` |
| `model_key_file` | 首次创建模型 API Key Secret `model-credentials` |
| `skill_repository_credential_file` | 可选，JSON，含只读 Git 仓库的 `Authorization` 请求头，创建 `agentos-skill-repository` |
| `AGENTOS_CHART_USER`、`AGENTOS_CHART_TOKEN` | 可选，下载私有 Helm 包 |

凭据文件权限为 0600，保存在仓库外或忽略的 `.cache/`。平台模型与 MCP 使用工作负载 JWT；目标系统凭据由运维环境管理。Helm values 以 JSON 文件传入，保留 JWK 的标准字段名。

平台以 Gateway API HTTPRoute 暴露 console（web）、平台 API 与可选的 MCP App 沙箱，Gateway 由站点提供：

```yaml
route:
  parentRefs: [{name: agentos-public, sectionName: https}]
  hosts: {console: agentos.example.com, api: api.agentos.example.com, sandbox: apps.agentos.example.com}
  from: [...]  # 站点网关 Pod 的 NetworkPolicy peer，默认 K3s 内置 Traefik
```

参考部署启用 K3s 内置 Traefik 的 Gateway API 支持，创建 Gateway `agentos-public` 与覆盖 `<agentos_domain>`、`*.<agentos_domain>` 的证书。
平台 API 只接受 Bearer 令牌；web 以 oauth2-proxy 持有浏览器会话并向 API 注入访问令牌，前端发布不重启平台 API。CLI、Controller UI
等客户端直接以 Bearer 访问 API 主机。

身份源由 `identity.mode` 选择，默认 `password`：内置身份源随 Chart 部署于 `https://<console>/identity`，以 oidc-provider 签发标准令牌。
登录页只校验站点密码，令牌主体为单一共享用户并携带全部应用角色与写角色；连续输错密码按来源地址与全站限速。站点密码保存在
`identity.secretRef`（默认 `agentos-identity`）的 `password` 键，参考部署首次安装时生成；签名密钥、客户端密钥与 Cookie 密钥由 Chart
生成于 `<release>-identity-keys`。启用外部身份提供方时配置：

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

机密客户端登记回调 `https://<console>/oauth2/callback`（web 登录）与 `https://<api>/delegation/callback`（离线委派），引用的 Secret
包含 `client-secret`。`returnOrigins` 登记 console 之外允许完成委派后返回的前端源。会话与委派 Cookie 的密钥由 Chart 生成于 `<release>-sessions`。
方案 Chart 的平台值位于 `app_values.agentos`。平台 API 校验访问令牌的 `iss`、`aud`、`exp`、`iat`、`sub` 与签名，`roles` 数组包含 `writerRole` 时授予写权限，其余认证用户可聊天和执行只读查询。API audience 与登录 clientId 分别配置，ID Token 的登录客户端受众不能替代 API 受众。
后台执行使用用户的离线授权：console 登录后自动跳转平台 API 的 `/delegation/start` 完成授权，其他客户端向用户展示 `GetAccessProfile.delegation_url`。
RPC 使用官方 Protobuf `NO_SIDE_EFFECTS` 标记声明读取操作；认证用户可管理自己的对话、交互和取消，配置写操作分别要求智能体、Skill、MCP、团队知识、模型或 Harness 的应用角色；角色可组合，目录由发布包 `authorization.json` 提供。目标系统写角色仅决定运维操作上限。实际工具调用独立校验会话与 Agent 权限，见[执行授权](execution-authorization.md)。
执行授权复用 PostgreSQL 连接及 CA Secret；`<release>-execution` 保存加密密钥，升级保留，备份时与数据库一并保存。

```sh
python3 -m venv .cache/deploy-venv
.cache/deploy-venv/bin/pip install -r deploy/requirements.txt
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-galaxy collection install -r deploy/requirements.yaml
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-playbook deploy/deploy.yaml -i <site>/inventory.yaml -e @<site>/vars.yaml
```

标签 `node`、`runtime`、`model`、`ingress`、`app` 可单独执行；更新应用使用 `--tags app`。不使用 Cloudflare 时跳过 `ingress`，自行准备域名解析、
TLS Secret `agentos-ingress` 与 Gateway。站点密码可用 `kubectl -n <namespace> get secret agentos-identity -o jsonpath='{.data.password}' | base64 -d` 读取。节点就绪后，`deploy/validate.yaml` 以服务端 dry-run 校验 microVM 资源；在节点上执行
`python3 deploy/verify-runtime.py <namespace>` 创建一次 microVM 沙箱，核验执行、挂起恢复后的文件与 KVM 进程。

## 语音

模型接入页的“语音模型”分别管理转写和语音合成；聊天页按能力显示麦克风和助手回答的朗读控件。
模型管理权限允许修改服务地址、模型、语言、音色与访问密钥；配置保存后用于新请求，无需重启控制台。
未配置语音服务时，两项能力默认关闭。
聊天录音通过 Deepgram Live 兼容的 `WS /v1/listen` 持续发送音频和接收中间、最终转写结果。
转写 `protocol: PROTOCOL_WHISPERLIVEKIT` 接入原生 `/asr`，平台将完整草稿映射为浏览器流式结果，保留模型的分词和空格。
平台使用官方 Deepgram SDK 与 WebSocket 组件，认证与同源校验位于平台代理，模型凭据留在服务端。
文件转写接口使用 `POST /v1/audio/transcriptions`（multipart 文件上传、JSON 文本响应），TTS 服务提供
`POST /v1/audio/speech`（`model`、`voice`、`input`、`response_format: mp3`，返回音频）。
合成 `protocol: PROTOCOL_NEMO` 接入 NeMo-Speech.cpp HTTP 服务，使用 WAV 和音色对应的语言参数。
合成语言优先匹配非拉丁正文，再匹配完整文本；中文、阿拉伯语内嵌的英文术语沿用正文音色，未匹配时使用首个音色。
模型和音色由站点提供，服务可以与文本模型同机部署；文件转写和语音合成使用 OpenAI SDK。
`languageCodes` 声明转写服务支持的语言，聊天页显示语言选择，初始选择匹配界面语言，之后记住用户选择。
选择自动识别时省略语言参数；代理仅转发配置内的语言代码。
语音合成 RPC 使用服务器流返回音频；支持对应 MediaSource 格式的浏览器收到首段即可播放，其他格式由浏览器完整解码后播放。
录音期间文本作为完整草稿更新；停止后显示尾部处理状态，可取消，等待上限为 15 秒，已识别文字保留。

```yaml
speech:
  transcription:
    endpoint:
      baseUrl: https://speech.example.test/v1
    model: multilingual-asr
    languageCodes: [zh, en, ar]
  synthesis:
    endpoint:
      baseUrl: https://speech.example.test/v1
    voices:
      - {languageCode: zh, model: tts-zh, voice: default}
      - {languageCode: en, model: tts-en, voice: default}
      - {languageCode: ar, model: tts-ar, voice: default}
  secretRef: speech-credentials
```

方案 Chart 的初始配置位于 `app_values.agentos.speech`。仅启用一项时，另一项保留 `{}`。
Helm 首次创建 `<release>-speech` Secret，后续升级保留模型管理页保存的配置与凭据。
配置与凭据在同一 Secret 中按 `resourceVersion` 原子更新；并发编辑冲突需刷新后重新保存。
合成配置至少包含一个音色，每种语言配置一个模型和音色；平台按文本语言选择，首项作为无法识别时的默认值。
语言代码使用 ISO 639，重复语言被拒绝；语音语言独立于界面语言。
`secretRef` 可省略；配置时引用已有 Kubernetes Secret，启用转写需要 `transcription-api-key`，启用合成需要
`synthesis-api-key`。管理接口只返回密钥是否配置；留空保留原密钥，显式清除会停止使用引用密钥。
开发环境通过 `AGENTOS_SPEECH_SECRET` 指定设置 Secret 的名称，默认 `<release>-speech`；
`configuration.json` 使用 `SpeechConfiguration` 的 proto JSON。

录音使用浏览器 MediaRecorder，需 HTTPS 或 localhost 与麦克风授权；每次最多 60 秒、1 MiB。
采集保留回声消除，关闭浏览器降噪和自动增益，减少对识别音素和音量包络的改写。
中间转写在录音期间持续更新输入框，停止录音后提交尾部音频，最终文本由用户发送。
朗读最多 8,000 字符、返回音频最多 16 MiB；模型请求期限为 60 秒。每个控制台实例最多四路并发录音。
切换对话会取消录音和播放。音频仅在请求期间保留于内存，平台不保存录音、音频文件或生成公共音频地址。
开放访问和 OIDC 均支持；只读用户可使用语音，目标系统的写权限继续由执行授权决定。

## 发布校验

Chart 校验使用 `ci/check-charts.sh`：helm-unittest 覆盖模板与非法值，Conftest 覆盖跨资源、权限及部署配置约束，kubeconform 使用固定上游 CRD 验证。后置渲染器通过标准库 unittest 验证资源边界。
GitLab Runner 启用原生作业目录清理；契约构建仅使用源码，不下载无关运行时二进制制品。
