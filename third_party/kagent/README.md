# kagent 协议来源

基础协议来自 kagent `v1.0.0-alpha17`，提交 [`8392184232e9c78196433a34b1fd3b33db5fcb97`](https://github.com/kagent-dev/kagent/tree/8392184232e9c78196433a34b1fd3b33db5fcb97/proto)。Memory 身份范围扩展与 `runtime/kagent/platform.patch` 一同维护，CI 校验协议一致性。

`kagent/api/v1/interactions.proto` 和 `collaboration.proto` 来自 [kagent PR #3414](https://github.com/kagent-dev/kagent/pull/3414) 的提交 [`a134acb28c871b2c817b558e1a39b0dd16fb8d4d`](https://github.com/pood1e/kagent/tree/a134acb28c871b2c817b558e1a39b0dd16fb8d4d/proto/kagent/api/v1)。这两份协议尚未发布，用于生成 HITL、工具活动及协作 MCP 的共享类型；运行时继续使用上述基础版本。

TypeScript 与 Python 客户端由仓库的 Buf 配置生成。上游许可证保存在 [LICENSE](LICENSE)。
