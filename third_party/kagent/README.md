# kagent 协议来源

全部协议来自 [pood1e/kagent 的固定提交 `722f06c11509ec64d3a99ae17e349d83a854de11`](https://github.com/pood1e/kagent/tree/722f06c11509ec64d3a99ae17e349d83a854de11/proto)，基于上游 `v1.0.0-alpha17`，与 [运行时构建](../../runtime/kagent/README.md) 使用同一份源码。CI 逐份校验协议一致性。

`kagent/api/v1/interactions.proto` 和 `collaboration.proto` 提供 HITL、工具活动及协作 MCP 的共享类型；`kagent/runtime/v1` 提供原生持久化协议。

TypeScript 与 Python 客户端由仓库的 Buf 配置生成。上游许可证保存在 [LICENSE](LICENSE)。
