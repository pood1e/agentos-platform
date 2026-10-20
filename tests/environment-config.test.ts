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
  it("models direct execution without an approval portal or credentials", () => {
    const environment = create(EnvironmentSchema, { name: "sim", governance: Governance.DIRECT });
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, { environment }),
      ).kind,
    ).toBe("valid");
  });
  it("uses native human decisions when no external approval service is configured", () => {
    const environment = create(EnvironmentSchema, {
      name: "publishing",
      governance: Governance.APPROVAL,
    });
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, { environment }),
      ).kind,
    ).toBe("valid");
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, {
          environment,
          approvalUrl: "https://decisions.example",
          authorization: "Bearer service-credential",
        }),
      ).kind,
    ).toBe("valid");
  });
});
