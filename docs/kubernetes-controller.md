# Kubernetes 控制器

## 资源与所有权

`controller/api/v1alpha1` 定义 `AccessPlan` 与 `Preset`；`ci/generate-controller.sh` 生成 CRD，
`scripts/generate-kubernetes.mjs` 从 CRD 生成 TypeScript 类型和 Helm values schema。

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
API 不执行派生对象写入或补偿。

预置首次应用后，未修改的对象随方案版本更新。API 编辑以 `agentos-users` 写入并声明
`agentos.dev/ownership: user`，同时解除 Preset ownerReference；直接修改产生的 SSA 冲突也移交用户。
控制器记录移交结果，方案升级和预置删除均保留用户对象；已移交后删除的对象保持删除。

## 部署与验证

平台与环境 Chart 安装 CRD 和相应控制器，方案通过 AccessPlan 与 Preset 声明期望状态。
首次安装由站点提供凭据 Secret 和执行加密 Secret，Helm values 指定相应名称。

安装后检查 AccessPlan / Preset 的 Ready、连接父对象的 AgentOSReady 条件，以及应用授权就绪状态。
更新工具分级或身份范围后，控制器重新编译；旧 generation 的决策停止参与授权。
删除父对象由 Kubernetes 回收派生资源，预置升级保留已归用户的对象。

## 渲染语义核对

基线为 `6f98388`，场景取平台 `tests/fixtures/chart-values.yaml`、示例方案 Chart、
环境与连接 Chart 各自的 `tests/values.json`。新声明通过 `controller/cmd/render` 使用同一编译器展开。

| 场景 | 旧对象数 | 新对象数 | 增加 / 移除 |
| --- | ---: | ---: | --- |
| 平台 | 44 | 57 | 控制器 5 个、AccessPlan 1 个、Preset 6 个、路由认证策略 2 个；加密 Secret 由站点提供 |
| 示例方案 | 53 | 67 | 平台变化，加方案 Preset 1 个 |
| 环境 | 35 | 41 | 控制器 5 个、AccessPlan 1 个 |
| 连接 | 72 | 88 | AccessPlan 1 个、各身份路由认证策略 15 个 |

有效差异逐项如下：

- 预置对象、连接父对象增加控制器声明与描述注解；原生对象的名称、工具集合、模型参数、Skill 和 Harness 配置保留。
- 工具绑定增加原生 `apiGroup`，明确 `requireApproval: false`；分组顺序按服务和审批属性固定。
- RemoteMCPServer 明确 `STREAMABLE_HTTP`，`10m` 序列化为等价的 `10m0s`。
- 平台 Gateway 保留 JWT 签名验证与模型鉴权；MCP 路径、主体和 audience 的组合校验移至路由策略。
  环境 Gateway 保留 Strict JWT，身份 `azp` 在各路由验证。
- Catalog 路由使用 Backend 目标引用；主体、服务受众、工具白名单和只读上限继续由跨资源断言与授权负例验证。
- ConfigMap 移除运行时工具分级文件，仅保留工作负载授权配置；对应 Deployment 配置 checksum 更新。
- API Role 改为读取 AccessPlan，派生资源写权限移交控制器 Role。
- 预置、Skill、语音 Secret 和嵌入 PVC 移除 Helm keep；执行加密 Secret 改为站点拥有。

API Server 集成用例覆盖中断后清理孤儿、预置升级、用户编辑保留、缺少凭据恢复。
Chart 校验包含原生 schema、主体、audience、路由覆盖和只读不变量；运行时测试覆盖跨身份、未知工具和同名跨服务工具拒绝。
完整站点的 microVM 执行和网关请求仍由站点回归验证。
