# AgentOS Platform

基于 [kagent](https://kagent.dev) 的 AgentOS 平台，提供 Agent 团队协作、工具治理、团队知识、Skill 管理与控制台。
业务通过方案包配置角色、工具、环境连接器与界面展示。

- **运行与协作**：microVM 执行环境、Agent 委派、会话与任务、定时执行。
- **工具治理**：执行身份、工具分级、原生工具确认、环境身份映射与外部审批。
- **交互与扩展**：模型接入、团队知识、Skill 目录、MCP Apps 与语音。

## 部署

参考部署使用 Ansible collection 安装 K3s、原生运行时与平台 Chart，Agent 运行节点需支持 KVM。
制品验签、站点变量与安装步骤见[构建与部署](docs/delivery.md)，目标系统接入见[环境接入](docs/environments.md)。

## 开发

工具版本由 [mise.toml](mise.toml) 与锁文件固定。数据库使用 PostgreSQL 18/pgvector。

```sh
mise install --locked
docker compose up --wait
export CHANGE_TEST_DATABASE_URL='postgresql://postgres:agentos-dev@localhost:55432/agentos?sslmode=disable'
mise exec -- npm ci
mise exec -- npm run verify
docker compose down
```

`npm run verify` 执行生成、构建、静态检查与单元测试。

前端开发连接已部署的平台 API。复制 [`.env.example`](.env.example) 为 `.env`，设置 API 地址与 Bearer 令牌后启动：

```sh
set -a
. ./.env
set +a
mise exec -- npm run dev
```

开发代理将 `AGENTOS_API_TOKEN` 注入 API 请求。本地 API 调试使用 `mise exec -- npm run server`，依赖 PostgreSQL、Kubernetes、OIDC 与原生运行时；配置见 [API Deployment](charts/agentos/templates/console-deployment.yaml)。

## 文档

| 主题 | 文档 |
| --- | --- |
| 架构与源码 | [架构](docs/architecture.md)、[代码导航](docs/code-navigation.md)、[Kubernetes 控制器](docs/kubernetes-controller.md) |
| 构建与部署 | [构建、发布与站点配置](docs/delivery.md) |
| 授权与环境 | [执行授权](docs/execution-authorization.md)、[环境接入](docs/environments.md) |
| 业务扩展 | [扩展契约](docs/extension.md)、[MCP Apps](docs/mcp-app.md) |
| 语音 | [听写、朗读与 LiveKit 通话](docs/speech.md) |

## 许可证

[Apache-2.0](LICENSE)
