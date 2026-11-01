# kagent 协议来源

全部协议来自 [pood1e/kagent 的固定提交 `852629af657f9e337c05e56d2a0650c292e5086f`](https://github.com/pood1e/kagent/tree/852629af657f9e337c05e56d2a0650c292e5086f/proto)。[`ci/verify-runtime-protos.sh`](../../ci/verify-runtime-protos.sh) 逐份校验协议一致性。

`kagent/api/v1/task_catalog.proto` 提供授权范围内的任务目录与活动查询；`interactions.proto` 和 `collaboration.proto` 提供 HITL、工具活动及协作 MCP 的共享类型；`kagent/runtime/v1` 提供原生持久化协议。

TypeScript 与 Python 客户端由仓库的 Buf 配置生成。上游许可证保存在 [LICENSE](LICENSE)。
