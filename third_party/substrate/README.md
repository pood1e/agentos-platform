# Agent Substrate 协议

`api/ateapi/v1/ateapi.proto` 取自 [kagent-dev/substrate `v1.0.0`](https://github.com/kagent-dev/substrate/tree/563df06f6be751c101539986896c17c55aa22a9d)，与 kagent 的依赖版本一致。

平台复用原生 Actor、元数据、出站策略及签名身份 RPC。生成代码由 Buf 与现有契约发布流程管理。
`ci/verify-runtime-protos.sh` 比较固定提交的原生 proto 与此导出副本。
