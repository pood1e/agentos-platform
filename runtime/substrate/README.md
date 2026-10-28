# Substrate 运行时构建

API 与 microVM worker 从 [pood1e/substrate](https://github.com/pood1e/substrate/tree/776c8825a8207993fc15b132714ef670eb28120f) 的固定提交 `776c8825a8207993fc15b132714ef670eb28120f` 编译，基于 Substrate `0.6.0-alpha3`（`e2fc0fa9f77ab5fc09eb01b43ccd74bd84c67c71`）。fork 回移两项现有修复：

- [Substrate #2159](https://github.com/agent-substrate/substrate/pull/2159) 的 `ActorTemplate.golden_egress_policy`，在同一事务内为首次准备的实例创建出站规则。普通会话继续使用 kagent 根据运行配置生成的凭证与权限。
- [Giant Swarm 的启动出站修复](https://github.com/giantswarm/substrate/commit/6be3d50cd5d309044d622e8bd3a344a013b4cea7)，在执行容器前启用出站通道，入站通道仍等待就绪探针。

[`ci/prepare-substrate.sh`](../../ci/prepare-substrate.sh) 拉取固定提交，并与协议副本比对。测试通过 `SUBSTRATE_TEST_POSTGRES_URL` 使用 CI PostgreSQL。

[`ci/verify-substrate.sh`](../../ci/verify-substrate.sh) 验证规则、事务回滚、准备隔离、隧道生命周期和 microVM，再基于同版本官方镜像构建 API 与 worker。

镜像摘要固定在 `deploy/vars.yaml`。kagent 的协议适配由 [运行时源码](../kagent/README.md) 提供。
