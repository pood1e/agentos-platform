# Skill 启动修复

基础版本为 Substrate `0.6.0-alpha3`，源码提交 `e2fc0fa9f77ab5fc09eb01b43ccd74bd84c67c71`。

`golden-skills.patch` 回移两项现有修复：

- [Substrate #2159](https://github.com/agent-substrate/substrate/pull/2159) 的 `ActorTemplate.golden_egress_policy`，在同一事务内为首次准备的实例创建出站规则。普通会话继续使用 kagent 根据运行配置生成的凭证与权限。
- [Giant Swarm 的启动出站修复](https://github.com/giantswarm/substrate/commit/6be3d50cd5d309044d622e8bd3a344a013b4cea7)，在执行容器前启用出站通道，入站通道仍等待就绪探针。

协议沿用上游 proto 的字段 9 和 `EgressPolicyTemplate`。生成代码使用上游固定的 protoc 25.3。PostgreSQL 测试支持 CI 的 `SUBSTRATE_TEST_POSTGRES_URL`；每个测试使用隔离数据，配置错误直接导致验证失败。

CI 验证规则、事务回滚、首次准备与普通会话隔离、隧道生命周期和 microVM，再从同版本官方镜像替换 API 与 worker 二进制。Substrate 出站网关采用同版本官方 Chart 固定的 agentgateway 镜像；业务 MCP 网关由平台 Gateway 配置管理。

镜像摘要固定在 `deploy/vars.yaml`。kagent 的协议适配由 [运行时源码](../kagent/README.md) 提供。
所选发布版本包含上述修复并通过站点回归后，移除对应本地补丁。
