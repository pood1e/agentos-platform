# 环境接入

环境套件把一套托管环境接入平台：在环境集群部署环境网关、连接器的身份路由，在平台集群登记环境连接与每个身份的工具视图。
目标系统、连接器 MCP 服务及其在目标系统中的账号由方案包或站点提供。

```mermaid
flowchart LR
  Agent[Agent] --> PG[平台网关]
  PG -->|身份密钥 + X-Agentos-Engineer| EG[环境网关]
  EG -->|按身份选择后端凭据| MCP[连接器 MCP]
```

## 组成

| 剧本 | 位置 | 内容 |
| --- | --- | --- |
| `environments/deploy.yaml` | 环境集群 | agentgateway、环境网关与身份密钥、每个身份每个服务的后端与路由 |
| `environments/connect.yaml` | 平台集群 | 环境连接 Secret `agentos-governance`、身份凭据、服务目录、读写工具视图与 RemoteMCPServer，预置角色的默认工具绑定，回收退出范围的身份 |

团队配置取自方案 Chart 的 `global.agentos`（见[扩展契约](extension.md#chart-入参)），环境的治理模式、工具分级与身份档案只维护一份。
身份 `catalog` 为平台保留，用于发现各服务的工具，须对每个服务有只读访问。

## 方案提供的内容

| 内容 | 约定 |
| --- | --- |
| 连接器 MCP 服务 | 部署在环境网关命名空间（默认 `mcp`），Pod 标签 `agentos.dev/component: mcp-server`，只接受环境网关的流量 |
| 后端凭据 | 每个身份在目标系统的账号凭据，以 Secret 存放在环境网关命名空间，名称与键由 `environment_connectors` 引用 |
| 外部审批服务 | 可选，方案包实现 `agentos.governance.v1.ApprovalService`，维护业务决定及其执行约束 |


`environment_connectors` 按服务描述环境网关的后端目标，`auth` 为 agentgateway 原生后端鉴权，`<identity>` 在渲染时替换为身份名；
`access` 限定目标只对指定访问级别生效。可选 `userAuth` 使用相同的原生 BackendAuth 结构声明用户委派，`<environment>` 替换为环境名；配置后按已授权的执行类型分别路由，凭证交换失败直接拒绝。接线与生命周期见[执行授权](execution-authorization.md)。

```yaml
environment_connectors:
  kubernetes:
    title: Kubernetes
    targets:
      - host: kubernetes-mcp.mcp.svc.cluster.local
        port: 8000
        auth: {secretRef: {name: backend-<identity>, key: kubernetes}}
  tickets:
    title: Tickets
    targets:
      - {host: tickets-mcp.mcp.svc.cluster.local, port: 8214, path: /mcp, protocol: SSE,
         auth: {secretRef: {name: backend-<identity>, key: tickets}, location: {header: {name: X-Ticket-Token}}}}
      - {name: tickets-write, access: [operate, manage], host: tickets-write-mcp.mcp.svc.cluster.local, port: 8000,
         auth: {secretRef: {name: tickets-api-<identity>, key: token}}}
```

## 站点变量

清单的 `environments` 组每台主机对应一套环境，`ansible_host` 为平台访问环境网关的地址：

| 主机变量 | 说明 |
| --- | --- |
| `environment_name` | 与 `global.agentos.environments` 中的名称一致 |
| `environment_kubeconfig` | 环境集群凭据，默认 `.cache/environments/<name>/kubeconfig.yaml` |
| `approval_service_url` | 可选，外部审批 Connect 服务地址；省略时使用原生人工确认 |
| `approval_service_authorization_file` | 可选，外部审批服务的 Authorization 内容文件，仅服务端使用 |
| `environment_links` | 可选，环境页展示的门户链接 `{name, url}` |

| 变量 | 说明 |
| --- | --- |
| `agentos_values_file` | 含 `global.agentos` 的方案 Chart 值文件 |
| `environment_connectors` | 连接器后端描述 |
| `platform_cidr` | 允许访问环境网关的平台地址段 |
| `gateway_rules` | 可选，环境网关额外放行的 CEL 表达式 |
| `registry_config_file` | 可选，Docker JSON，创建镜像拉取凭据 `agentos-registry` |

```sh
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-playbook environments/deploy.yaml -i <site>/environments.yaml -e @<site>/environments-vars.yaml
ANSIBLE_CONFIG=deploy/ansible.cfg .cache/deploy-venv/bin/ansible-playbook environments/connect.yaml -i <site>/environments.yaml -e @<site>/environments-vars.yaml
```

环境网关密钥生成在 `.cache/environments/<name>/secrets/`，目录权限 0700，需纳入控制端备份。`deploy.yaml` 的标签为
`gateway`、`backends`。`connect.yaml` 初始化缺失的服务与预置角色的默认绑定，保留控制台中保存的服务配置与角色绑定。
