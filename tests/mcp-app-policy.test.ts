import { expect, it } from "vitest";
import { appResourcePolicy } from "../shared/mcp-apps-policy.js";

it("grants only explicitly requested data resources from untrusted metadata", () => {
  expect(
    appResourcePolicy({
      csp: {
        resourceDomains: ["data:", "https://untrusted.example"],
        connectDomains: ["https://untrusted.example"],
      },
      permissions: { camera: {} },
      domain: "https://untrusted.example",
    }),
  ).toEqual({ resourceDomains: ["data:"] });
  expect(appResourcePolicy({ csp: { resourceDomains: ["https://untrusted.example"] } })).toEqual(
    {},
  );
  expect(appResourcePolicy(undefined)).toEqual({});
});
