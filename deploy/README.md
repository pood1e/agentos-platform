# AgentOS 参考部署

Ansible collection `agentos.platform`，在 Ubuntu 主机（amd64 或 arm64）安装单节点 K3s、Agent Substrate、kagent、agentgateway 与 [AgentOS 平台](https://github.com/pood1e/agentos-platform) Chart，并接入目标环境。
collection 随平台同版本发布，安装同一源码提交的平台 Chart 与镜像；上游版本与运行时镜像摘要见 [playbooks/deploy/vars.yaml](playbooks/deploy/vars.yaml)。

| 入口 | 作用 |
| --- | --- |
| `agentos.platform.install` | 安装或升级节点、运行时、网关、域名、语音与平台应用 |
| `agentos.platform.access` | 安装目标环境网关并发布平台连接，见[环境接入](docs/environments.md) |
| `agentos.platform.connections` | 更新平台环境连接 |
| `agentos.platform.lifecycle` | 识别需撤销目标凭据的退役身份 |
| 角色 `agentos.platform.node_dns` | 配置节点与 Pod DNS |

## 安装与升级

站点 inventory 与变量保存在仓库外，`agentos` 组包含一台主机，主机名作为 Kubernetes 节点名：

```yaml
all:
  children:
    agentos:
      hosts:
        agentos-01: {ansible_host: 192.0.2.10, ansible_user: admin}
```

从平台发布记录取得版本与源码提交，使用站点信任的[平台公钥](https://github.com/pood1e/agentos-platform/blob/main/ci/cosign.pub)校验并安装，`$REGISTRY` 为平台制品注册表路径：

```sh
collection="$REGISTRY/collections/platform"
digest=$(oras resolve "$collection:$VERSION")
cosign verify --key /etc/agentos/agentos-platform.pub --insecure-ignore-tlog \
  -a "version=$VERSION" -a "revision=$REVISION" "$collection@$digest"
oras pull "$collection@$digest" --output .cache/delivery
ansible-galaxy collection install ".cache/delivery/agentos-platform-$VERSION.tar.gz"
ansible-playbook agentos.platform.install -i <site>/inventory.yaml -e @<site>/vars.yaml
```

控制端安装 collection 根目录 `requirements.txt` 的 Python 依赖，并提供 Helm、cosign、ORAS 与 Kustomize。playbook 安装前以 collection 内的平台公钥校验平台 Chart 与镜像的签名、版本和源码提交。
升级时安装新版已验签 collection 后执行同一 playbook。kagent 使用 fork 发布的固定摘要 Chart；Substrate 与 agentgateway 使用官方 Chart。资源调整经 Helm 4 `postrenderer/v1` 插件与 Kustomize overlay 应用。

| 站点变量 | 内容 |
| --- | --- |
| `agentos_domain` | 控制台域名，DNS / 证书覆盖该域及通配子域 |
| `dns_zone` | Cloudflare DNS 区域，用于记录与 ACME DNS-01 |
| `app_chart`、`app_chart_repository`、`app_chart_version` | 应用 Chart，默认同版本平台 Chart；业务部署选择方案 Chart |
| `app_chart_revision`、`app_chart_public_key` | 应用源码提交与签名公钥，默认取同版本平台；公钥为空时应用 Chart 只校验版本与源码提交 |
| `app_values` | 应用 Chart 值，方案 Chart 的平台配置位于 `app_values.agentos`，字段见[平台交付文档](https://github.com/pood1e/agentos-platform/blob/main/docs/delivery.md) |
| `app_release_name`、`agentos_namespace` | release 与命名空间，均默认 `agentos` |
| `agentos_cache` | 缓存目录，默认 `$XDG_CACHE_HOME/agentos` 或 `~/.cache/agentos` |
| `node_hosts` | 可选节点 hosts 记录 `{name, address}` |
| `node_dns_servers`、`node_dns_over_tls` | 节点与 Pod 的上游 DNS 及是否使用 DNS over TLS，默认 Cloudflare `1.1.1.1` / `1.0.0.1` 加 DoT；需要解析内网域名的站点改用内网解析器 |
| `ingress_ports` | K3s 内置 Traefik 在节点上暴露的 `{http, https}` 端口，默认 `80` / `443`；节点已有其他入口时改用空闲端口，由该入口按 SNI 透传 |
| `kagent_telemetry` | 可选 kagent 原生 `TelemetryConfig`，应用于控制面与运行时默认值 |
| `openfga_bootstrap_subject` | 初始管理员的 OIDC `sub`；站点以当前工作空间 UID 建立成员与管理员绑定 |
| `kagent_authorization_api_token_secret`、`kagent_authorization_ca_secret` | OpenFGA API 凭据和 CA 的 Secret `{name, key}`，默认分别为 `openfga-auth/keys` 与 `openfga-ca/tls.crt` |
| `cnpg_operator_managed`、`cnpg_operator_namespace` | 是否由 collection 安装 CloudNativePG Operator 及其命名空间，默认 `true` 与 `cnpg-system`；站点已有 Operator 时设为 `false` 并填写其命名空间，数据库资源由站点 Operator 管理，网络策略放行该命名空间 |
| `agentgateway_managed` | 是否由 collection 安装 agentgateway CRD 与控制器，默认 `true`；集群已有控制器时设为 `false`，collection 校验 GatewayClass 已接受且控制器不低于 `agentgateway_version`，站点控制器需监听 AgentOS 命名空间 |
| `kagent_postgres_resources` | 原生 PostgreSQL 的 Kubernetes requests 与 limits，默认请求 100m / 256Mi，上限 1 CPU / 1Gi |
| `kagent_postgres_pool_max_conns` | 每个 kagent 控制器的 PostgreSQL 连接上限，默认 16；与 Substrate 连接及数据库 `max_connections` 统一分配容量 |
| `substrate_worker_resources` | 每个 microVM worker 的 Kubernetes requests 与 limits，默认请求 500m / 4Gi，上限 4 CPU / 4Gi；limits 即该 worker 分配给 Agent 运行时的容量，需大于最大运行时规格与开销之和 |
| `substrate_sandbox_class` | Agent 运行时的沙箱类：`microvm`（默认，节点需支持 KVM）或 `gvisor`（无嵌套虚拟化的节点），worker 镜像取 `substrate_worker_images` 中同类的固定摘要 |
| `runtime_check_image` | 安装后运行时自检的镜像，默认官方 Python 镜像摘要；无法访问 Docker Hub 的站点改用镜像站的同一摘要 |
| `kagent_execution_authorization` | 原生 `ExecutionAuthorizationConfig` 的 `scopeClaim`、`rules` 与 `gatewayAudiences`；资源规则使用原生 `ResourceScopeRule`，覆盖本站启用的 API 与运行时资源 |

collection 固化 `delivery_version`、`delivery_revision` 与 `agentos_image_registry`，即所属平台的版本、源码提交与镜像注册表路径；方案 Chart 依赖同一平台版本。
`app_values.agentos.api.workspaces` 声明附加工作空间目标；collection 为这些 namespace 建立原生控制器的 watch 与 RBAC 范围。

| 凭据输入 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` / `cloudflare_token_file` | DNS 与 ACME 凭据 |
| `model_key_file` | 首次创建 `model-credentials` 的模型 API Key |
| `identity_client_secret_file` | 站点 OIDC 机密客户端密钥，写入 `identity.secretRef` |
| `registry_config_file` | Docker JSON，用于制品下载、验签与镜像拉取 |

凭据文件使用 0600 权限，保存在仓库外或 `.cache/`。Helm values 通过 JSON 文件传入。
参考部署启用 K3s Traefik 的 Gateway API，创建 `agentos-public` 与域名证书，并首次生成 `<release>-sessions` 会话 Secret，升级复用。

启用语音时，部署首次生成 `voice.sessionSecretRef`（默认 `agentos-voice-sessions`）的 API 专用签名密钥，与 LiveKit 凭据分别保存。升级复用已有密钥；轮换后重启 API 并重新建立语音会话。

应用部署将 Substrate 当前 live Service DNS ClusterTrustBundle 发布为平台命名空间的 `substrate-service-dns-ca` ConfigMap，供 agentgateway 直接验证 Actor JWKS HTTPS 端点。Service DNS 根轮换时执行 `agentos.platform.install --tags app` 同步信任；轮换期间保留覆盖现有服务证书的根。Actor 签名公钥由原生 JWKS 端点发布，刷新由 agentgateway 管理。

原生 kagent API 验证 `identity.issuer` 的签名与 `identity.audience`，OAuth 续期使用 `identity.clientId`、同一客户端 Secret 和 discovery 的 HTTPS token endpoint。站点首次生成 `kagent-execution-credentials` 中的 32 字节加密密钥，升级复用；该 Secret 设为 immutable 且仅挂载到 controller，保证持久凭据与加密密钥一致。备份 PostgreSQL 时同时备份此 Secret。浏览器会话 Cookie 与登录刷新由 oauth2-proxy / IdP 管理。

私有 IdP 通过 `identity.caCertificateRef` 引用平台命名空间的 ConfigMap key；同一 CA 用于浏览器、后台委托及原生 OIDC / OAuth。控制端为 Ansible 配置同一 IdP CA 信任。

`kagent_execution_authorization` 直接采用[原生配置](https://github.com/pood1e/kagent/blob/f86dfd5dea88c7438e9b63168055b50c768f52ac/proto/kagent/config/v1/config.proto)；`rules` 声明资源、动词与允许的角色，`gatewayAudiences` 逐项列出模型与 MCP 网关的精确 HTTP(S) origin，并包含每个环境服务的 `http://<environment>-<project>-mcp-gateway.<namespace>.svc.cluster.local:8080`，与对应 Actor 凭据的受众一致。部署填入加密密钥和 OAuth Secret 路径。示例见[原生执行权限测试值](tests/fixtures/execution-authorization.yaml)，站点按启用的资源与网关补齐允许清单；`SessionAllCreators` 授予平台管理角色读取其他发起人的 Session，与控制台系统执行视图一致。

站点从已校验的 kagent Chart 读取原生授权模型，在平台 PostgreSQL 集群 `kagent-postgres` 的 `openfga` 库和 store 中安装模型；store、model ID 与已引导的工作空间 UID 保存在 `openfga-state` ConfigMap。每个新工作空间首次授予初始主体成员与授权管理员角色，业务角色和管理员轮换通过原生绑定接口配置。升级按模型摘要更新，已有工作空间的绑定由授权接口管理。collection 为 kagent 配置该 store，并从独立 Secret 挂载 OpenFGA API 凭据与 CA。

`TaskStore` 与 `ToolInventory` 使用绑定 Actor 的原生运行时入口，示例规则采用认证身份许可。TaskStore 持久化与终态清理由 Actor / Session 绑定和派发预约约束，执行准入与撤权另由原生权限链维护。

运行时控制面直接连接 `kagent-controller:8083`。其 NetworkPolicy 允许同命名空间的业务网关、平台 API/dataplane、controller，以及 `ate-system` 的 `atenet-egress` 访问，策略随原生 kagent release 管理。站点授予 controller 创建 TokenReview 的权限，并保留 K3s 内置的 NetworkPolicy 控制器。

站点在 `route.hosts.api` 发布原生 `/agents/` A2A HTTP，以及 A2A、Session、Execution 的 gRPC 服务，使用 h2c Service 转发至原生控制面。入口 NetworkPolicy 复用 `route.from`，默认仅允许 K3s Traefik；原生 OIDC、资源权限与执行归属共同约束外部调用。

MCP 发现凭据由各 RemoteMCPServer 的原生 `discoveryAuth` 管理，controller 按引用的 ServiceAccount 签发短期 Token。站点按 Kubernetes 官方方式向网关开放 ServiceAccount issuer discovery 与公开 JWKS，TLS 信任使用集群 CA。

```yaml
kagent_telemetry:
  traces: {endpoint: 'https://otlp.example.com:4317', protocol: grpc, timeout: 5s}
  metrics: {endpoint: 'https://otlp.example.com/v1/metrics', protocol: http/protobuf}
  logs: {endpoint: 'https://otlp.example.com/v1/logs', protocol: http/protobuf}
```

kagent 各信号按配置启用，内容与原始请求体采集默认关闭，分别由 `captureContent` / `captureRawApiBodies` 控制。

## 运行验证

部署标签 `node`、`runtime`、`model`、`ingress`、`voice`、`app` 支持分项执行，应用更新用 `--tags app`。
自管 DNS / TLS 的站点提供 Gateway 与 `agentos-ingress` Secret，跳过 `ingress`。
节点就绪后，`playbooks/deploy/validate.yaml` 进行服务端 dry-run；节点上的 `python3 playbooks/deploy/verify-runtime.py <namespace>` 验证原生沙箱执行与挂起恢复。

## 开发与发布

collection 位于平台仓库 `deploy/`，与平台 Chart、镜像在同一流水线打包、签名和发布；校验入口为 `ci/check-collection.sh`，见[构建与发布](https://github.com/pood1e/agentos-platform/blob/main/docs/delivery.md#构建与发布)。
