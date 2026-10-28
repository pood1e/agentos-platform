# 真实组件验证

本目录提供原生 microVM、网关、身份提供方和目标 API 的集成验证脚本。

## 原生运行时与 MCP

验证环境需要 kagent、Substrate、可用模型、标准 Harness、agentgateway，以及支持 ActorJWTSource 的宿主机出站网关。
Actor issuer 使用原生签名池与 JWKS 服务，隔离验证的签发服务模板为 `tests/fixtures/authorization/runtime-issuer.yaml`。

渲染变量：

| 变量 | 内容 |
| --- | --- |
| `PROOF_WORKSPACE` | 平台验证命名空间 |
| `PROOF_IMAGE` | 包含平台 Node 依赖的不可变镜像 |
| `PROOF_KAGENT_INTERNAL_URL` | 接收服务访问的原生控制面地址 |
| `PROOF_GATEWAY_PARAMETERS` | 同命名空间现有 AgentgatewayParameters |

运行时镜像凭据引用 `agentos-registry`。Agent 引用现有 `default-model-config` 与 `standard` Harness。

```sh
mkdir -p .cache/authorization-proof/rendered
chmod 700 .cache/authorization-proof
npx esbuild tests/proofs/runtime-server.ts --bundle --packages=external --platform=node --format=esm --outfile=.cache/authorization-proof/runtime-server.mjs
python3 - <<'PY'
import os
from pathlib import Path
from string import Template
for name in ('runtime', 'gateway', 'agent'):
    source = Path('tests/fixtures/authorization') / f'{name}.yaml'
    output = Path('.cache/authorization-proof/rendered') / f'{name}.yaml'
    output.write_text(Template(source.read_text()).substitute(os.environ))
PY
kubectl -n "$PROOF_WORKSPACE" create configmap agentos-authorization-proof --from-file=runtime-server.mjs=.cache/authorization-proof/runtime-server.mjs --dry-run=client -o yaml > .cache/authorization-proof/configmap.yaml
kubectl -n "$PROOF_WORKSPACE" apply --server-side --dry-run=server --validate=strict -f .cache/authorization-proof/configmap.yaml -f .cache/authorization-proof/rendered/
kubectl -n "$PROOF_WORKSPACE" apply --server-side -f .cache/authorization-proof/configmap.yaml -f .cache/authorization-proof/rendered/
kubectl -n "$PROOF_WORKSPACE" wait agent/authorization-proof --for=condition=Ready --timeout=180s
```

客户端变量：

| 变量 | 内容 |
| --- | --- |
| `PROOF_KAGENT_URL` | 客户端可达的原生控制面地址 |
| `PROOF_SUBSTRATE_URL` | HTTPS Control API 地址 |
| `PROOF_SUBSTRATE_SERVER_NAME` | 端口转发时的服务证书 DNS 名，可选 |
| `PROOF_CA_FILE` | 原生服务 CA 公钥文件 |
| `PROOF_TOKEN_FILE` | 可创建测试会话出站策略、读取 Actor 与签发测试 JWT 的临时 Control API 凭据文件 |
| `PROOF_TOOL_ORIGIN` | `http://authorization-proof.<workspace>.svc.cluster.local:8080` |
| `PROOF_GATEWAY_URL` | 客户端可达的 `/mcp/authorization-proof` 地址 |
| `PROOF_EVIDENCE_URL` | 客户端可达的接收服务 `/evidence` 地址 |

```sh
npx tsx tests/proofs/native-client.ts
```

客户端创建独立 Session，在其已声明目标上配置五分钟 Actor JWT 注入，执行工具并核对原生工具结果；随后暂停、恢复并再次执行。
同一连接中验证允许与拒绝调用，拒绝后比较接收端计数。身份判定取自签名声明与原生状态。客户端最后删除自己创建的 Session，保留失败原因与清理异常。
接收服务只输出验证元数据与计数，令牌留在 HTTP 头和受信组件中。issuer 与 audience 分别匹配原生签发方和包含明确端口的目标 origin。

## Keycloak Token Exchange

使用实际 Keycloak 管理账号的凭据文件，脚本创建随机命名的独立 realm，采用官方 Admin Client 与 openid-client，结束后删除该 realm。
初始用户令牌通过测试 realm 的 Direct Access Grant 取得；平台登录采用 Authorization Code 与 PKCE，见[执行授权](../../docs/execution-authorization.md#凭证与生命周期)。

```sh
PROOF_KEYCLOAK_URL=https://identity.example.test \
PROOF_KEYCLOAK_ADMIN_PASSWORD_FILE=/run/proof/keycloak-admin \
npx tsx tests/proofs/keycloak-exchange.ts
```

`PROOF_KEYCLOAK_ADMIN_USERNAME` 默认 `admin`。`PROOF_KEYCLOAK_ADDRESS` 可指定验证站点的连接 IP，证书主机名与 TLS 校验继续使用配置 URL。
测试覆盖两个用户、只读角色 scope、交换客户端限制、目标 API 读写权限、额外 scope、错误 audience、用户刷新与注销。
客户端策略来自 `tests/proofs/keycloak-policy.json`。

## NetBox 服务身份桥接

凭据文件使用现有只读服务 Token，连接通过 HTTPS。写权限探测使用测试对象 ID `0`，验证权限校验先于对象查找。

```sh
PROOF_NETBOX_URL=https://inventory.example.test \
PROOF_NETBOX_TOKEN_FILE=/run/proof/netbox-reader \
npx tsx tests/proofs/netbox-bridge.ts
```

`PROOF_NETBOX_ADDRESS` 用于站点连接 IP，TLS 校验保留。该测试验证服务账号的原生权限上限，用户资源过滤另由方案包接入。

## 清理

```sh
kubectl -n "$PROOF_WORKSPACE" delete -f .cache/authorization-proof/rendered/ --ignore-not-found
kubectl -n "$PROOF_WORKSPACE" delete configmap agentos-authorization-proof --ignore-not-found
```

临时安装的 issuer 按其 fixture 单独删除。验证创建的临时凭据文件、端口转发与网关试验版本在结束后清理或恢复；生产资源继续由平台部署入口管理。
