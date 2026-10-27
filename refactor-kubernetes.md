# 计划二：Kubernetes 编排与交付

[架构收敛重构](refactor.md)的并行计划之一，负责 Kubernetes 资源编排、方案预置、制品交付与上游收敛。设计见[总览](refactor.md#设计)，与[计划一](refactor-services.md)的分工与同步约定见[并行计划](refactor.md#并行计划)。

单元 2.1、2.2 已实现；上游收敛随所选发布版本持续验证。

## 范围

| 类别 | 内容 |
| --- | --- |
| 控制器 | 新增 `controller/`（Go、controller-runtime） |
| 服务端 | `server/management`、`server/governance`、`server/console/{roles,role-template,template-writer}.ts` |
| 前端 | `src/features/{engineers,management}`，不含语音配置页面 |
| 协议 | `proto/agentos/{management,governance}` 与 `console/v1/role.proto` |
| Chart | `charts/agentos` 中网关、模型、Harness、Skill、嵌入模型、预置与工具分级模板；`charts/agentos-environment` 与 `charts/agentos-connections` |
| 交付与运行时 | `environments/`、`deploy/`、`ci/`、`runtime/`、`scripts/`、`contracts/`、`third_party/`、`tests/policies` |

## 单元

### 2.1 平台控制器

按总览的[平台控制器](refactor.md#平台控制器)设计实施。`AccessPlan` 的 Informer 放在 `server/governance`，dataplane 经该模块读取编译结果。首版直接部署目标资源模型，派生资源与方案预置由控制器管理。

删除：

- `server/management/{changes,bindings,mcp-services,credential-references}.ts` 与 `connections.ts` 的派生写入，错误类型 `management.partialSave`。
- `server/governance/bindings.ts` 的标签解析。
- `charts/agentos/templates/{_environment-tools,_presets}.tpl`、`charts/agentos-connections/templates/identity-views.yaml`、`charts/agentos-environment/templates/backends.yaml` 的分级推导，以及 Chart 中全部 `lookup` 与 `resource-policy: keep`。
- `environments/templates/initialize-service-tools.yaml.j2` 与 `environments/connect.yaml` 的绑定追加。
- `tests/policies/tools.rego` 的分级推导，保留跨资源 audience、主体、路由覆盖与越权不变量。
- `scripts/generate-environment-schema.mjs` 与手写 `values.schema.json` 中由 CRD schema 覆盖的部分；Gateway 级拼接的 CEL。

验收：

- 站点配置的原生资源语义符合目标设计，渲染差异逐条列明。
- reconcile 中途终止后收敛；连接保存为单次写入。
- 用户修改过的预置在方案包升级后保留，未修改的预置随之更新。
- 跨身份、只读写入、未知工具与同名跨服务工具的授权负例保持拒绝。

### 2.2 交付

- 镜像与 Chart 使用 OCI 并以 cosign 签名，安装前验签；npm 与 Python 契约发布到 GitLab 注册表；参考部署交付 Ansible collection。
- 上游 Chart 的资源补丁改用 Kustomize post-renderer。
- 发布范围包含计划一当时已引入的全部镜像；CI 工具镜像重建后更新 `ci/toolchain.gitlab-ci.yml` 的固定摘要。

删除：generic package 发布、`deployment.tar.gz`、`proto/agentos/distribution/v1` 发布清单与 `ci/` 中对应的打包、清单和发布脚本；`deploy/gateway/kagent-post-renderer.py` 与 `deploy/microvm/substrate-post-renderer.py`；消费方的 `platform.lock.json`、`fetch-platform.py`、`scripts/fetch-agentos-contracts.mjs` 与 `agentos-contracts.lock.json`。

验收：干净环境从注册表完成安装与升级；篡改或错版本的制品被拒绝；同一版本的镜像、Chart、包与 collection 来自同一源码提交。

### 上游收敛

独立推进；所选发布版本包含对应能力且站点回归通过后删除本地实现。

- kagent [#3244](https://github.com/kagent-dev/kagent/issues/3244) 发布后删除续接协调。
- kagent 补丁按 MemoryService 身份范围、Actor 身份头、Harness 工具约束与准备策略提交上游。
- kagent 公开 HITL 与工具调用元数据协议后删除 `proto/agentos/kagent/v1/wire.proto`。
- Substrate [#2159](https://github.com/agent-substrate/substrate/pull/2159) 与启动出站修复进入发布版本后删除 `runtime/substrate/golden-skills.patch`。

续接协调与 `wire.proto` 的删除涉及计划一的代码，由上游发布后在计划一中实施。

## 顺序

2.1 → 2.2；上游收敛独立推进。
