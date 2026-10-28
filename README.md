# AgentOS Platform

基于 [kagent](https://kagent.dev) 的 Agent 交互与接入层，提供 Web 控制台和输入能力增强。
Agent 执行、会话、任务持久化与 HITL 使用 kagent；方案包提供业务角色、工具、环境连接器与业务流程。

- **控制台**：Agent 团队、聊天与执行历史、原生工具确认、MCP Apps。
- **输入**：文本与可选的语音输入、朗读和实时通话。
- **接入**：身份与执行授权、模型和 MCP 配置、团队知识与 Skill 目录。

## 部署

参考部署通过 Ansible collection 安装 K3s、运行时与平台 Chart，运行节点需支持 KVM。语音、遥测和外部执行入口按需启用。
制品验签、站点变量与安装步骤见[构建与部署](docs/delivery.md)，目标系统接入见[环境接入](docs/environments.md)；kagent 与 Substrate 运行时由 [pood1e/kagent](https://github.com/pood1e/kagent/tree/agentos/1.0.0-alpha17) 与 [pood1e/substrate](https://github.com/pood1e/substrate/tree/agentos/v0.6.0-alpha3) 的 `agentos/*` 分支构建并发布镜像。

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

开发代理使用 `AGENTOS_API_TOKEN` 转发 API 请求。本地服务调试依赖 PostgreSQL、Kubernetes、OIDC 与运行时，进程入口见[代码导航](docs/code-navigation.md)，环境配置见 [api Deployment](charts/agentos/templates/api-deployment.yaml)及同目录模板。

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
