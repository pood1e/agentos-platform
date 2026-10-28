import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { describe, expect, it } from "vitest";
import {
  EnvironmentConnectionSchema,
  EnvironmentSchema,
  Governance,
} from "../gen/agentos/governance/v1/governance_pb.js";

describe("environment service boundaries", () => {
  const validator = createValidator();
  const oauth = {
    issuer: "https://identity.example/realm",
    resource: "https://environment.example/mcp",
  };
  it("models direct execution without an approval portal or credentials", () => {
    const environment = create(EnvironmentSchema, { name: "sim", governance: Governance.DIRECT });
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, { environment, ...oauth }),
      ).kind,
    ).toBe("valid");
  });
  it("models native tool confirmation with environment OAuth", () => {
    const environment = create(EnvironmentSchema, {
      name: "publishing",
      governance: Governance.APPROVAL,
    });
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, { environment, ...oauth }),
      ).kind,
    ).toBe("valid");
  });
});
