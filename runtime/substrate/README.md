# Skill 启动修复

基础版本为 Substrate `0.5.0-alpha2`，源码提交 `9c4b1fb52212028100fa02c8a7bc4526575ea37e`。

`golden-skills.patch` 回移两项现有修复：

- [Substrate #2159](https://github.com/agent-substrate/substrate/pull/2159) 的 `ActorTemplate.golden_egress_policy`，在同一事务内为首次准备的实例创建出站规则。普通会话继续使用 kagent 根据运行配置生成的凭证与权限。
- [Giant Swarm 的启动出站修复](https://github.com/giantswarm/substrate/commit/6be3d50cd5d309044d622e8bd3a344a013b4cea7)，在执行容器前启用出站通道，入站通道仍等待就绪探针。

协议沿用上游 proto 的字段 9 和 `EgressPolicyTemplate`。生成代码使用上游固定的 protoc 25.3。PostgreSQL 测试支持 CI 的 `SUBSTRATE_TEST_POSTGRES_URL`；每个测试使用隔离数据，配置错误直接导致验证失败。

CI 验证规则、事务回滚、首次准备与普通会话隔离、隧道生命周期和 microVM，再从同版本官方镜像替换 API 与 worker 二进制。Substrate 出站网关使用维护中的 agentgateway `2.3.6` 构建，包含启动状态鉴权修复；业务 MCP 网关仍由各自的 Gateway 配置管理。

镜像摘要固定在 `deploy/vars.yaml` 与 `deploy/values/substrate.yaml`。kagent 的协议适配位于 `runtime/kagent/golden-skills.patch`。
