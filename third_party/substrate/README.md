# Agent Substrate 协议

`ateapi.proto` 取自 [pood1e/substrate](https://github.com/pood1e/substrate/tree/776c8825a8207993fc15b132714ef670eb28120f)，基于 `v0.6.0-alpha3` 并包含[运行时构建](../../runtime/substrate/README.md)回移的出站协议，与部署底座保持一致。

平台复用原生 Actor、元数据、出站策略及签名身份 RPC。生成代码由 Buf 与现有契约发布流程管理。
`ci/prepare-substrate.sh` 比较固定提交的原生 proto 与此导出副本。
