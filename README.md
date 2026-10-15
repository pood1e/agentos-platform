# AgentOS Platform

以 [kagent](https://kagent.dev) 1.0 为底座、与具体业务无关的 AgentOS 平台。平台负责 Agent 团队的运行、协作、受治理的工具访问、团队知识、
Skill 目录、模型接入与控制台；业务以方案包提供团队、Skill、工具分级、环境连接器与文案，不修改平台代码。

| 平台负责 | 方案包负责 |
| --- | --- |
| kagent、Agent Substrate、agentgateway 的固定版本与必要补丁 | 业务角色（AgentTemplate / Agent）、提示词与 Harness 选择 |
| 控制台、协作服务（team-sessions）、变更控制（change-control） | Skill 内容 |
| 环境网关的身份映射、读写工具视图与 ExtMCP 写调用守卫 | 各连接器 MCP 的工具分级与角色访问级别 |
| 审批链路与 Zammad 参考提供方 | 环境清单、连接器 MCP 与目标系统 |
| 团队知识（原生记忆、嵌入模型）、Skill 目录、模型接入 | 角色名、头像、工具标签与图标 |
| 平台 Chart、环境套件与部署 | 业务 Chart 值与部署变量 |

## 状态

抽取中。代码从内部仓库 aiops-mvp（基线 `3ad31c1`）抽取，AIOps 成为首个方案包；映射与切换步骤见
[抽取方案](docs/extraction.md)，进度见 [#2](https://github.com/pood1e/agentos-platform/issues/2)。

## 开发

需要 Node.js 24.13 或更高版本。

```sh
npm ci
npm run verify      # 生成代码、构建、Biome / buf lint / tsc 检查与单元测试
npm run test:e2e    # 浏览器测试，使用 fake kagent 与示例方案包
```

变更控制的集成测试需要 PostgreSQL，设置 `CHANGE_TEST_DATABASE_URL` 后执行，未设置时跳过。本地调试参考 `.env.example`：
`npm run dev:kagent` 启动 fake kagent，`npm run server` 启动控制台服务，`npm run dev` 启动前端。

## 文档

- [架构](docs/architecture.md)：组件、调用链路、部署形态与安全边界
- [代码导航](docs/code-navigation.md)：目录与模块职责
- [扩展契约](docs/extension.md)：方案包可提供的内容与格式
- [抽取方案](docs/extraction.md)：aiops-mvp 的路径映射、泛化改动与一次性切换步骤

## 许可证

[Apache-2.0](LICENSE)
