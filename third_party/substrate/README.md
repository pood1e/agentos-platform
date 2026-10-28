# Agent Substrate 协议

`ateapi.proto` 取自 [pood1e/substrate](https://github.com/pood1e/substrate/tree/cb535faf1cc568a71a3053dc61e8485876f89dc9) 的固定提交，基于 `v0.6.0-alpha3` 并回移 [Substrate #2159](https://github.com/agent-substrate/substrate/pull/2159) 的出站协议，与部署底座保持一致。

平台复用原生 Actor、元数据、出站策略及签名身份 RPC。生成代码由 Buf 与现有契约发布流程管理。
`ci/verify-runtime-protos.sh` 比较固定提交的原生 proto 与此导出副本。
