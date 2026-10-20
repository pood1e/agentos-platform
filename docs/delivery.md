# 构建与部署

## 构建与发布

GitLab CI 入口为 [`.gitlab-ci.yml`](../.gitlab-ci.yml)，运行时作业见 [`ci/runtime.gitlab-ci.yml`](../ci/runtime.gitlab-ci.yml)，镜像构建模板见
[`ci/build.gitlab-ci.yml`](../ci/build.gitlab-ci.yml)。

| 作业 | 内容 |
| --- | --- |
| `verify` | 生成、构建、Biome / buf lint / tsc、单元测试（临时 PostgreSQL）与浏览器测试 |
| `deployment-check` | ansible-lint 与语法检查；平台 Chart 和[示例方案 Chart](../tests/fixtures/solution-chart) 的渲染断言、kubeconform 严格校验与 post-renderer 测试；环境套件的渲染断言与 kubeconform 校验 |
| `controller-verify`、`substrate-verify` | 对固定上游源码应用 `runtime/` 补丁，执行 race 测试、lint 并编译；仅在运行时相关文件变更时触发 |
| `build-*` | rootless BuildKit 构建 console、kagent controller、Substrate、Harness、Langfuse Web 镜像，推送到 `$CI_REGISTRY_IMAGE` |
| `build-contracts` | 发布 Python protobuf wheel、部署源码包及 SHA-256 清单，按 Git 提交固定 |
| `release` | 打包带镜像摘要的平台 Chart，发布到 OCI 注册表；功能分支版本追加提交摘要 |

仓库内的镜像以摘要固定、注册表用占位符：Chart 值使用 `registry.example.com/agentos`，部署变量使用 `agentos_image_registry`。
发布时占位符替换为 `$CI_REGISTRY_IMAGE`。运行时镜像更新分两步：运行时作业构建出新摘要后，在 `deploy/vars.yaml` 与
`charts/agentos/values.yaml` 更新固定摘要；发布作业核对本次构建的摘要与固定值一致。

| CI/CD 变量 | 说明 |
| --- | --- |
| `AGENTOS_SHELL_RUNNER` | Shell runner 标签：Node.js 24、PostgreSQL 18 与 pgvector、Playwright Chromium、Python 3 |
| `AGENTOS_COMPILER_RUNNER` | Go 测试与编译的 runner 标签 |
| `AGENTOS_BUILDKIT_RUNNER` | rootless BuildKit 的 runner 标签 |
| `AGENTOS_BUILDKIT_IMAGE` | rootless BuildKit 镜像，按摘要固定 |
| `AGENTOS_CI_ENVIRONMENT` | 可选，Shell 作业开始时加载的环境脚本，如工具链 `PATH` |
| `AGENTOS_CI_CACHE` | 可选，工具与 Python 环境缓存目录，默认 `~/.cache/agentos` |
| `AGENTOS_REGISTRY_MIRROR` | 可选，BuildKit 使用的 Docker Hub 镜像源 |

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
| `agentos_domain` | 控制台域名 |
| `agentos_image_registry` | 平台运行时镜像所在的注册表路径，即构建时的 `$CI_REGISTRY_IMAGE` |
| `dns_zone` | Cloudflare 托管的 DNS 区域，用于域名记录与 ACME DNS-01 |
| `app_chart_repository` | 应用 Chart 所在的 OCI 仓库，如 `oci://registry.example.com/team/platform/charts` |
| `app_chart`、`app_chart_version` | 应用 Chart 名称与版本，默认平台 Chart `agentos` 与仓库内版本；方案部署填方案 Chart |
| `app_release_name` | Helm 发布名称，默认 `agentos` |
| `app_values` | 应用 Chart 的值：入口域名、模型、`global.agentos` 等 |
| `agentos_namespace` | 平台命名空间，默认 `agentos` |
| `node_hosts` | 可选，节点 `/etc/hosts` 追加的 `{name, address}` |

| 凭据 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `cloudflare_token_file` | DNS 记录与 ACME challenge |
| `registry_config_file` | Docker JSON，创建镜像拉取凭据 `agentos-registry` |
| `model_key_file` | 首次创建模型 API Key Secret `model-credentials` |
| `skill_repository_credential_file` | 可选，JSON，含只读 Git 仓库的 `Authorization` 请求头，创建 `agentos-skill-repository` |
| `AGENTOS_CHART_USER`、`AGENTOS_CHART_TOKEN` | 可选，下载私有 Helm 包 |

凭据文件权限为 0600，保存在仓库外或忽略的 `.cache/`。控制台页面和 RPC 直接访问；模型网关、MCP 与运维环境继续使用各自的机器凭据。升级应用后清理旧控制台 OIDC Secret。

升级到 0.3 时，从站点平台值中移除 `authorization`、`oauth2-proxy`，并删除部署变量 `oidc_secret_file`；方案 Chart 的平台值位于 `app_values.agentos`。
部署入口使用 `reset_values: true`，旧登录资源由 Helm 移除，OIDC Secret 在升级成功后清理。控制台访问者共享当前工作空间的操作与管理能力。

```sh
python3 -m venv .cache/deploy-venv
.cache/deploy-venv/bin/pip install -r deploy/requirements.txt
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-galaxy collection install -r deploy/requirements.yaml
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-playbook deploy/deploy.yaml -i <site>/inventory.yaml -e @<site>/vars.yaml
```

标签 `node`、`runtime`、`model`、`ingress`、`app` 可单独执行；更新应用使用 `--tags app`。不使用 Cloudflare 时跳过 `ingress`，自行准备域名解析与
TLS Secret `agentos-ingress`。节点就绪后，`deploy/validate.yaml` 以服务端 dry-run 校验 microVM 资源；在节点上执行
`python3 deploy/verify-runtime.py <namespace>` 创建一次 microVM 沙箱，核验执行、挂起恢复后的文件与 KVM 进程。

## Langfuse

`--tags observability` 管理独立的 Langfuse 与 OpenTelemetry Collector。站点传入 `langfuse_enabled: true`、
`langfuse_namespace`、`langfuse_domain` 和 `langfuse_admin_email`；镜像与 Chart 版本固定在 `deploy/vars.yaml`。
Web 使用[共享会话镜像](../runtime/langfuse/README.md)，访问者直接使用预置运维账号的组织和项目权限，页面和内部 RPC 免登录。
项目 API Key、采集身份与数据加密密钥继续保留。镜像拉取凭据从平台命名空间同步到观测命名空间。

从 OIDC 部署升级时，删除站点变量 `langfuse_oidc_secret_file` 及 `langfuse_values.langfuse.auth.providers`，
并删除 `additionalEnv` 中的 `AUTH_KEYCLOAK_ALLOW_ACCOUNT_LINKING`。站点覆盖值中的 `langfuse.web.image`
使用新镜像及摘要；成功升级后清理旧的 `langfuse-oidc` Secret。
