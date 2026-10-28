# Kubernetes 控制器

## 资源与所有权

`controller/api/v1alpha1` 定义 `AccessPlan` 与 `Preset`；`ci/generate-controller.sh` 生成 CRD，
`scripts/generate-kubernetes.mjs` 从 CRD 生成 TypeScript 类型和 Helm values schema。
CRD 统一存于 `controller/config/crd/bases`，源码验证与发布打包时分发到平台和环境 Chart；CI 校验生成结果与提交一致。

| 声明 | 管理者 | 派生对象 |
| --- | --- | --- |
| `AccessPlan` | Helm / GitOps | 身份 Backend、RemoteMCPServer、HTTPRoute 与路由认证策略 |
| `Preset` | Helm / GitOps | 方案的原生 Agent、AgentTemplate、Harness、模型、Skill 目录与语音设置 |
| 原生 AgentgatewayModel / Backend | 方案预置或管理 API | ModelConfig、RemoteMCPServer、HTTPRoute 与认证策略 |

控制器以命名空间为边界运行，两副本通过 Lease 选主。环境模式只维护环境网关资源。
派生对象使用独立 SSA field manager、父对象 controller ownerReference 和 UID 索引；重启后从索引恢复尚未写入 status 的对象。
`Ready=True` 且 `observedGeneration` 等于当前 generation 时，`AccessPlan.status.targets` 才可参与授权。
Informer 断开、计划未就绪、冲突的编译结果、未知工具均拒绝授权。
`shared/access-plans.ts` 与 `shared/tool-bindings.ts` 随 npm 契约发布，平台治理与环境审批服务共用编译结果读取接口。
环境模式同时发布目录与各身份的工具决策，审批属性取自环境的治理模式。

管理 API 每次只写一次原生连接父对象，凭据单独写入该对象拥有的 Secret。
凭据写入失败时父对象保留，控制器记录 `AgentOSReady=False`；重试保存后继续收敛。

预置首次应用后，未修改的对象随方案版本更新。API 编辑以 `agentos-users` 写入并声明
`agentos.dev/ownership: user`，同时解除 Preset ownerReference；直接修改产生的 SSA 冲突也移交用户。
控制器记录移交结果，方案升级和预置删除均保留用户对象；已移交后删除的对象保持删除。

## 部署

平台与环境 Chart 安装 CRD 和相应控制器，方案通过 AccessPlan 与 Preset 声明期望状态。
首次安装由站点提供凭据 Secret 和执行加密 Secret，Helm values 指定相应名称。

安装后检查 AccessPlan / Preset 的 Ready、连接父对象的 AgentOSReady 条件，以及应用授权就绪状态。
更新工具分级或身份范围后，控制器重新编译；旧 generation 的决策停止参与授权。
删除父对象由 Kubernetes 回收派生资源，预置升级保留已归用户的对象。

## 验证

| 入口 | 范围 |
| --- | --- |
| `ci/check-charts.sh` | 平台、方案示例与环境 Chart 的模板、原生 schema 和跨资源策略 |
| `controller/internal/compile` | 工具分级、身份视图、连接与预置编译 |
| `controller/internal/reconcile` | 真实 API Server 上的中断恢复、资源回收、凭据恢复与用户所有权 |
| `ci/test-artifacts.py` | 两个 Chart 共用 CRD 的打包、签名和内容校验 |

版本化验证记录见[环境 Chart 验证](../tests/proofs/environment-charts.md)。
