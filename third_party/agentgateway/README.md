# agentgateway API schemas

Official CRDs from `oci://cr.agentgateway.dev/charts/agentgateway-crds:v1.6.0`, chart digest `sha256:dd7f965d43e54dffa9c95af089b6f762397a23c963a159ad6d4992f6c582292a`.

`models.yaml` and `backends.yaml` retain the upstream schema. `scripts/generate-management.mjs` extracts the native spec schemas for management forms; Kubernetes remains responsible for CRD and CEL validation.

`proto/agentgateway/dev/ext_mcp/ext_mcp.proto` is the MCP guardrails wire protocol from tag `v1.6.0` (commit `ea5608642b9d5c94c5baf5fd9f2f9849b808e963`, `crates/protos/proto/ext_mcp.proto`), licensed under Apache-2.0 (`LICENSE`).
