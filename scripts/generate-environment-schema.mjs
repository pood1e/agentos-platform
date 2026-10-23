import { readFileSync, writeFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const root = read("charts/agentos/values.schema.json");
const shared = root.properties.global.properties.agentos.properties;
const spec = read("gen/schema/agentgateway.mcp.json");
const target = spec.properties.mcp.properties.targets.items.properties.static.properties;
const authentication = structuredClone(target.policies.properties.auth);
const tokenURL = authentication.properties.oauthTokenExchange.properties.url;
tokenURL.anyOf = [{ pattern: tokenURL.pattern }, { pattern: "^<issuer>(/[^?#]*)?$" }];
delete tokenURL.pattern;
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const text = { type: "string", minLength: 1 };
const https = { type: "string", format: "uri", pattern: "^https://[^/]+" };
const port = { type: "integer", minimum: 30000, maximum: 32767 };
const identifier = shared.environments.items.properties.name;
const gateway = object({ address: text, host: text, nodePort: port, ca: text });
const trust = root.properties.execution.properties;
const common = { toolsets: shared.toolsets, identities: shared.identities };
const environment = object({
  environment: object({ name: identifier, issuer: https, resource: https, jwksURL: https }),
  gateway: object({
    address: text,
    host: text,
    nodePort: port,
    platformCIDR: text,
    image: object({
      registry: text,
      repository: text,
      tag: text,
      digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    }),
  }),
  ...common,
  connectors: {
    type: "object",
    minProperties: 1,
    additionalProperties: object(
      {
        title: text,
        targets: {
          type: "array",
          minItems: 1,
          items: object(
            {
              name: text,
              access: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: { enum: ["read", "operate", "manage"] },
              },
              host: target.host,
              port: target.port,
              path: target.path,
              protocol: target.protocol,
              auth: authentication,
            },
            ["host", "port"],
          ),
        },
      },
      ["targets"],
    ),
  },
});
environment.properties.toolsets.minProperties = 1;
environment.properties.identities.minItems = 1;
environment.properties.identities.contains = object({ name: { const: "catalog" } }, ["name"]);
environment.properties.identities.contains.additionalProperties = true;
const connections = object({
  platform: object({
    release: identifier,
    controllerServiceAccount: identifier,
    actorIssuer: https,
    actorJWKS: trust.actorJWKS,
    kubernetesIssuer: https,
    kubernetesJWKS: trust.kubernetesJWKS,
  }),
  environments: {
    type: "array",
    items: object(
      {
        name: identifier,
        governance: { enum: ["approval", "direct"] },
        issuer: https,
        resource: https,
        gateway,
        ...common,
        titles: { type: "object", additionalProperties: text },
        approvalUrl: https,
        authorization: text,
      },
      ["name", "governance", "issuer", "resource", "gateway", "toolsets", "identities", "titles"],
    ),
  },
});
for (const [name, schema] of [
  ["agentos-environment", environment],
  ["agentos-connections", connections],
])
  writeFileSync(
    `charts/${name}/values.schema.json`,
    `${JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", ...schema }, null, 2)}\n`,
  );
