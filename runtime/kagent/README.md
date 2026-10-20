# kagent 控制平面扩展

基础版本为 `1.0.0-alpha11`，源码提交 `30e8a2c2ceb9a1fadc16e969aa7ee0107a42d7b2`。

`delete-memory-entry.patch` 为原生 MemoryService 增加 `DeleteEntry` RPC，按知识 ID、工程师和用户执行单条删除。请求经过 Protovalidate、原生删除权限策略及调用者身份校验，存储使用现有 pgx 客户端和参数化 SQL。未找到或不属于目标范围的记录返回 NotFound。整库清空仍使用原生 Delete。

补丁包含 proto、生成的 Go/TypeScript/Python 协议、服务、存储和测试。`dbtest` 支持 CI 提供的 PostgreSQL，每次创建隔离的临时数据库。

`golden-skills.patch` 将运行配置声明的出站目标传递给 Substrate 的首次准备策略，凭证值仍由网关保管。运行模板版本参与 revision 摘要，升级后重建不可变模板；普通会话的凭证注入规则保持独立。依赖的 Substrate 协议和启动出站修复见 [Skill 启动修复](../substrate/README.md)。

`actor-identity.patch` 为已声明的 HTTP(S) 目标增加原生 ActorJWTSource，按包含明确端口的 origin 限定 audience，令牌有效期为五分钟。
运行时请求的 `x-substrate-actor-token` 占位值由宿主机替换；Secret 凭据保留独立规则，身份头作为保留字段。验证使用维护中的 Giant Swarm agentgateway-upstream 2.6.3。
`runtime-api.patch` 将托管 Harness 的 API 地址与出站目标统一到执行入口。入口只开放原生持久化 RPC，使用签名 Actor 解析实际会话并重建私有控制面身份；原生管理 API 的访问由 NetworkPolicy 限制。生产接线见[执行授权](../../docs/execution-authorization.md)。

`workload-headers.patch` 为标准、Codex、Claude 的原生持久化客户端与 MCP 编译配置提供 Actor 凭证占位头。Substrate 仅替换已存在的头，宿主按目标 origin 签发令牌；三个 Harness 均从固定上游源码构建并保留官方 CLI。

变更审批使用原生 HITL 暂停与恢复。目标环境按身份、工具和参数匹配已准备的变更，在网关内核验审批并原子占用执行权。

`claude-tool-selection.patch` 为 Claude 原生适配器补齐 MCP 工具子集。编译器保留 `mcp.tools`，将未选工具传给 Claude Code 官方 `--disallowedTools`；原生权限回调检查精确白名单，新增工具默认拒绝，选中工具按 `requireApproval` 决定直接执行或暂停。补丁同时更新 controller 和 Claude Harness，配置协议版本为 6。

CI 对固定源码应用补丁，在 PostgreSQL 18/pgvector 上执行 race 测试、SQL 准备检查和 Go lint，构建 controller 与 Claude Harness 二进制后替换同版本官方镜像中的程序。Claude Code CLI 保留官方固定版本。部署使用不可变镜像引用，通过现有 Helm post-renderer 管理原生 kagent release。
