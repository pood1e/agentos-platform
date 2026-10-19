# Langfuse Web

镜像基于固定摘要的官方 Langfuse 4.62.0，仅替换 NextAuth 4.24.15 的 Web 会话处理函数。访问者共享
`LANGFUSE_INIT_USER_EMAIL` 对应的预置用户，组织、项目和功能权限由 Langfuse 原生会话回调从数据库读取。
会话不依赖浏览器 Cookie，不签发登录凭据；公开 API 和 OpenTelemetry 采集继续使用项目 API Key。

`upstream.json` 固定官方镜像中认证模块的 SHA-256 和函数位置。构建时校验整个模块摘要及 JavaScript 语法，
上游代码变化会使构建失败。更新上游镜像时，依据 NextAuth 的 `core/routes/session.js` 重新核对该函数，
同步模块摘要、函数位置和部署镜像摘要，并验收匿名页面、内部 RPC 与采集 API 的访问行为。

构建和单元测试由 [`ci/langfuse.gitlab-ci.yml`](../../ci/langfuse.gitlab-ci.yml) 管理。
