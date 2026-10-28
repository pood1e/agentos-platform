# AgentOS 平台实施计划

## 当前能力

平台提供统一聊天助手、A2A 委派、MCP 工具访问、团队知识、Skill、模型和 Harness 管理、系统任务及可选语音。
平台 API 使用 Bearer 令牌；身份源为内置站点密码或外部 OIDC，用户会话与执行历史按发起人隔离。

执行绑定、凭据和读投影保存在 PostgreSQL。AccessPlan 与 Preset 统一管理工具授权和方案资源。
镜像、Chart 与部署 collection 使用 OCI 和 cosign，契约通过 npm / PyPI 注册表发布。

现行边界见[架构](docs/architecture.md)、[执行授权](docs/execution-authorization.md)与[扩展契约](docs/extension.md)。

## 后续工作

| 工作 | 内容 |
| --- | --- |
| [进程拆分](refactor.md#进程拆分) | api、dataplane、worker 独立部署与观测 |
| [语音单链路](refactor.md#语音单链路) | LiveKit Agents 承载听写、朗读、通话与轮次编排 |
| [逐资源授权](refactor.md#逐资源授权) | 团队、分享、继承与撤销 |
| [运维与上游](refactor.md#运维与上游) | 持续备份、密钥轮换、运行时版本回归与补丁收敛 |

## 后续产品能力

- 团队知识的文本文件导入。
- 配置版本历史与回滚。
