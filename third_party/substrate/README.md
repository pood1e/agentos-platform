# Agent Substrate 协议

`ateapi.proto` 基于 [kagent-dev/substrate](https://github.com/kagent-dev/substrate/tree/e2fc0fa9f77ab5fc09eb01b43ccd74bd84c67c71)，版本 `v0.6.0-alpha3`，包含平台现有 [golden-skills.patch](../../runtime/substrate/golden-skills.patch) 的启动出站协议回移，与部署底座保持一致。

平台复用原生 Actor、元数据、出站策略及签名身份 RPC。生成代码由 Buf 与现有契约发布流程管理。
`ci/prepare-substrate.sh` 比较应用补丁后的原生 proto 与此导出副本。
