# kagent 协议来源

全部协议来自 [pood1e/kagent 的固定提交 `a1f9d80ef4ed75d34eb09e57f54db5ee0ccb35ab`](https://github.com/pood1e/kagent/tree/a1f9d80ef4ed75d34eb09e57f54db5ee0ccb35ab/proto)，对应 fork `main` 的运行时构建，与部署镜像使用同一份源码。[`ci/verify-runtime-protos.sh`](../../ci/verify-runtime-protos.sh) 逐份校验协议一致性。

`kagent/api/v1/interactions.proto` 和 `collaboration.proto` 提供 HITL、工具活动及协作 MCP 的共享类型；`kagent/runtime/v1` 提供原生持久化协议。

TypeScript 与 Python 客户端由仓库的 Buf 配置生成。上游许可证保存在 [LICENSE](LICENSE)。
