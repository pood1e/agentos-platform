# 代码导航

| 路径 | 内容 |
| --- | --- |
| `proto/agentos/console/v1` | 控制台 RPC：会话、任务、角色、工具、方案包展示（`pack.proto`） |
| `proto/agentos/management/v1` | 管理 RPC：连接、模型、Harness、Skill、知识 |
| `proto/agentos/governance/v1` | 环境、连接与变更方案 |
| `proto/agentos/kagent/v1` | kagent 线上格式的补充定义 |
| `server/console` | 控制台服务：Connect RPC、静态资源、方案包加载、角色模板读写 |
| `server/read-model` | kagent 任务与事件的读模型：会话、调用、交互、协作画布 |
| `server/kagent` | kagent 官方客户端、Harness 与内置工具 |
| `server/management` | 管理页后端：kagent 与 agentgateway 原生资源的读写 |
| `server/knowledge` | 团队知识检索 |
| `server/team-sessions` | 协作 MCP：委派协调者、续接会话、知识检索、角色起草 |
| `server/operations` | 工具分级、身份绑定，以及原生暂停与环境审批之间的协调 |
| `server/change-control` | 环境侧变更控制：方案登记、ExtMCP 守卫、审批提供方接口与 Zammad 实现 |
| `server/shared`、`shared/` | 服务端公共配置、错误与前后端共用模型 |
| `src/app`、`src/components` | 前端路由、布局与 shadcn/ui 组件 |
| `src/features` | 聊天、任务、团队、管理、状态等页面 |
| `src/features/shared` | 头像、工具图标、审批与变更单等公共展示 |
| `src/lib` | RPC 客户端、方案包展示（`pack.ts`）与通用工具 |
| `src/i18n` | 平台通用文案 |
| `charts/agentos` | 平台 Chart：console、team-sessions、平台网关资源、嵌入模型、Harness、Skill 目录与系统 Agent |
| `tests` | 单元与集成测试；`tests/fake-kagent` 是录制驱动的 kagent 替身，`tests/e2e` 是浏览器测试 |
| `tests/fixtures/pack` | 示例方案包，供测试使用 |
| `third_party` | 上游协议、CRD 与组件来源 |
