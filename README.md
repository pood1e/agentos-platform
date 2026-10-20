# AgentOS Platform

以 [kagent](https://kagent.dev) 1.0 为底座、与具体业务无关的 AgentOS 平台。平台负责 Agent 团队的运行、协作、受治理的工具访问、团队知识、
Skill 目录、模型接入与控制台；业务以方案包提供团队、Skill、工具分级、环境连接器与文案，不修改平台代码。

| 平台负责 | 方案包负责 |
| --- | --- |
| kagent、Agent Substrate、agentgateway 的固定版本与必要补丁 | 业务角色（AgentTemplate / Agent）、提示词与 Harness 选择 |
| 控制台、协作服务（team-sessions）、原生工具确认 | Skill 内容 |
| 环境网关的身份映射、读写工具视图 | 各连接器 MCP 的工具分级与角色访问级别 |
| 原生 HITL 与可选的外部审批协议 | 业务审批服务、执行守卫、环境连接器与目标系统 |
| 团队知识（原生记忆、嵌入模型）、Skill 目录、模型接入 | 角色名、头像、工具标签与图标 |
| 平台 Chart、环境套件与部署 | 业务 Chart 值与部署变量 |

## 开发

需要 Node.js 24.13 或更高版本。

```sh
npm ci
npm run verify      # 生成代码、构建、Biome / buf lint / tsc 检查与单元测试
npm run test:e2e    # 浏览器测试，使用 fake kagent 与示例方案包
```

本地调试参考 `.env.example`：
`npm run dev:kagent` 启动 fake kagent，`npm run server` 启动控制台服务，`npm run dev` 启动前端。

## 文档

- [实施计划](plan.md)：当前优先级、身份与 OBO 实施阶段、控制台改进记录
- [架构](docs/architecture.md)：组件、调用链路、部署形态与安全边界
- [代码导航](docs/code-navigation.md)：目录与模块职责
- [构建与部署](docs/delivery.md)：CI、发布与单节点参考部署
- [执行授权](docs/execution-authorization.md)：用户身份、运行时边界、工具授权与 OBO
- [环境接入](docs/environments.md)：环境网关、身份绑定与可选审批服务
- [扩展契约](docs/extension.md)：方案包可提供的内容与格式
- [边界迁移](docs/domain-boundaries.md)：0.5 的契约变化与 AIOps 迁移

## 许可证

[Apache-2.0](LICENSE)
