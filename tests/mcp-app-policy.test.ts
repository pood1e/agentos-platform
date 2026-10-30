import { expect, it } from "vitest";
import { appResourcePolicy } from "../shared/mcp-apps-policy.js";

it("accepts only explicit HTTPS image origins and data resources", () => {
  expect(
    appResourcePolicy({
      csp: {
        resourceDomains: ["data:", "https://untrusted.example"],
        connectDomains: ["https://untrusted.example"],
      },
      permissions: { camera: {} },
      domain: "https://untrusted.example",
    }),
  ).toEqual({ resourceDomains: ["data:", "https://untrusted.example"] });
  expect(
    appResourcePolicy({
      csp: {
        resourceDomains: [
          "http://untrusted.example",
          "https://user@example.com",
          "https://example.com/path",
          "*",
        ],
      },
    }),
  ).toEqual({});
  expect(appResourcePolicy(undefined)).toEqual({});
});
