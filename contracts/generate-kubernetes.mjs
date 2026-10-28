import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compile } from "json-schema-to-typescript";
import { parse } from "yaml";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const crd = parse(readFileSync("controller/config/crd/bases/agentos.dev_accessplans.yaml", "utf8"));
const schema = crd.spec.versions[0].schema.openAPIV3Schema;
const spec = schema.properties.spec;
mkdirSync("gen/schema", { recursive: true });
const declarations = await Promise.all(
  ["spec", "status"].map((key) =>
    compile(schema.properties[key], `AccessPlan${key === "spec" ? "Spec" : "Status"}`, {
      additionalProperties: false,
      bannerComment: "",
      maxItems: -1,
    }),
  ),
);
writeFileSync("gen/kubernetes.ts", declarations.join("\n"));
writeFileSync("gen/schema/agentos.accessplan.json", `${JSON.stringify(schema)}\n`);

const root = read("charts/agentos/values.schema.json");
const properties = root.properties.global.properties.agentos.properties;
for (const name of ["environments", "toolsets", "identities"])
  properties[name] = spec.properties[name];
const controller = {
  type: "object",
  additionalProperties: false,
  required: ["image", "resources"],
  properties: {
    image: { type: "string", minLength: 1 },
    imagePullSecrets: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1 } },
      },
    },
    resources: root.properties.api.properties.resources,
  },
};
root.properties.controller = controller;
root.properties["agentos-controller"] = { type: "object" };
const save = (name, value) =>
  writeFileSync(`charts/${name}/values.schema.json`, `${JSON.stringify(value, null, 2)}\n`);
save("agentos", root);
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const text = { type: "string", minLength: 1 };
const https = { type: "string", pattern: "^https://[^/]+" };
const environment = spec.properties.environments.items;
const inputGateway = read("charts/agentos-environment/values.schema.json").properties.gateway;
const connectors = structuredClone(spec.properties.connectors);
const url =
  connectors.additionalProperties.properties.targets.items.properties.auth.properties
    .oauthTokenExchange.properties.url;
url.anyOf = [{ pattern: url.pattern }, { pattern: "^<issuer>(/[^?#]*)?$" }];
delete url.pattern;
const common = { toolsets: spec.properties.toolsets, identities: spec.properties.identities };
save("agentos-environment", {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...object(
    {
      environment: object(
        Object.fromEntries(
          ["name", "governance", "issuer", "resource", "jwksURL"].map((name) => [
            name,
            environment.properties[name],
          ]),
        ),
      ),
      gateway: inputGateway,
      ...common,
      connectors,
      controller,
      "agentos-controller": { type: "object" },
    },
    ["environment", "gateway", "toolsets", "identities", "connectors", "controller"],
  ),
});
const apiBundle = read("gen/schema/agentos.governance.v1.EnvironmentApi.jsonschema.bundle.json");
const { $schema, ...api } = apiBundle.$defs["agentos.governance.v1.EnvironmentApi.jsonschema.json"];
delete api.patternProperties;
const connectionEnvironment = structuredClone(environment);
connectionEnvironment.additionalProperties = false;
connectionEnvironment.required.push("issuer", "resource", "gateway", "tokenEndpointURL");
connectionEnvironment.properties.gateway.properties.ca = text;
Object.assign(connectionEnvironment.properties, {
  apis: { type: "array", items: api },
  tokenEndpointURL: https,
});
const jwt = read("third_party/agentgateway/jwt-provider.json");
jwt.required = [...new Set([...jwt.required, "audiences"])];
jwt.additionalProperties = false;
const jwtRef = { $ref: "#/definitions/jwtProvider" };
save("agentos-connections", {
  $schema: "http://json-schema.org/draft-07/schema#",
  definitions: { jwtProvider: jwt },
  ...object({
    platform: object(
      {
        release: text,
        controllerServiceAccount: text,
        actorIssuer: https,
        authentication: { oneOf: [jwtRef, { type: "object", maxProperties: 0 }] },
        writerRole: { type: "string" },
      },
      ["release", "controllerServiceAccount", "actorIssuer"],
    ),
    environments: { type: "array", items: connectionEnvironment },
  }),
  anyOf: [
    { properties: { environments: { maxItems: 0 } } },
    {
      properties: {
        platform: {
          required: ["authentication", "writerRole"],
          properties: { authentication: jwtRef, writerRole: text },
        },
      },
    },
  ],
});
