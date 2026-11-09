# kagent 协议来源

全部协议来自 [pood1e/kagent 的固定提交 `ac8778aa0909bdce07cd4181e543ad3669942f17`](https://github.com/pood1e/kagent/tree/ac8778aa0909bdce07cd4181e543ad3669942f17/proto)。[`ci/verify-runtime-protos.sh`](../../ci/verify-runtime-protos.sh) 逐份校验协议一致性。

`kagent/api/v1/authorization.proto` 提供资源权限查询及角色绑定管理；`kagent/api/v1/task_catalog.proto` 提供授权范围内的任务目录与活动查询；`interactions.proto` 提供 HITL 与工具活动的共享类型；`kagent/runtime/v1` 提供原生持久化协议。

TypeScript 与 Python 客户端由仓库的 Buf 配置生成。上游许可证保存在 [LICENSE](LICENSE)。
