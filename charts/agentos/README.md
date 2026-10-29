# MCP Apps

Configure an isolated sandbox origin and the issuer's published `jwks_uri`:

```yaml
mcpApps:
  sandboxOrigin: https://apps.example.test
identity:
  jwksURL: https://identity.example.test/keys
```

`route.hosts.sandbox` optionally hosts the platform sandbox at the matching origin. An externally hosted sandbox uses an empty host.

The AccessPlan owns `/apps/mcp/<server>` routes to each existing read-capable MCP backend. Viewer JWT validation and the API's source-invocation authorization run on every request. Tool calls require both the current Agent binding and the compiled read-only capability. Normal runtime MCP routes retain Actor authentication.

API authorization: `server/mcp-apps/authorization.ts`. Native gateway compilation: `controller/internal/compile/apps.go`.
