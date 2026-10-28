# kagent 运行时构建

控制平面与 kagent、Claude、Codex 三个 Harness 从 [pood1e/kagent](https://github.com/pood1e/kagent/tree/722f06c11509ec64d3a99ae17e349d83a854de11) 的固定提交 `722f06c11509ec64d3a99ae17e349d83a854de11` 编译，基于上游 `v1.0.0-alpha17`。同版本官方镜像提供基础运行环境，构建元数据记录实际源码提交。

fork 包含 Actor 身份与逐请求授权、Memory 用户范围、工具约束与审批恢复、托管 MCP 发现、持久化父子任务续接、共享交互 / 协作 proto 及首次准备网络支持。
原生持久化使用 `kagent.runtime.v1`，HITL 与协作使用 `kagent.api.v1`；协议来源见 [third_party/kagent](../../third_party/kagent/README.md)，启动网络依赖见 [Substrate](../substrate/README.md)。

[`ci/verify-controller.sh`](../../ci/verify-controller.sh) 拉取固定提交，逐份比对仓库内的上游 proto，在 PostgreSQL / pgvector 上运行原生授权、持久化、协作、Harness 与准备流程回归，执行上游 lint 后构建四个二进制。
镜像构建使用本目录 Dockerfile 和 [`runtime/harness-toolbox`](../harness-toolbox)，部署版本与镜像摘要见 [`deploy/vars.yaml`](../../deploy/vars.yaml)。
