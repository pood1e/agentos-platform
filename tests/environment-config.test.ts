import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { describe, expect, it } from "vitest";
import {
  EnvironmentConnectionSchema,
  EnvironmentSchema,
  Governance,
} from "../gen/agentos/governance/v1/change_pb.js";

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
  it("requires an approval portal and change-control credentials for approval environments", () => {
    const environment = create(EnvironmentSchema, {
      name: "real",
      governance: Governance.APPROVAL,
      links: [{ name: "Identity", url: "https://identity.example.com" }],
    });
    expect(validator.validate(EnvironmentSchema, environment).kind).not.toBe("valid");
    environment.approvalUrl = "https://tickets.example.com";
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, { environment }),
      ).kind,
    ).not.toBe("valid");
    expect(
      validator.validate(
        EnvironmentConnectionSchema,
        create(EnvironmentConnectionSchema, {
          environment,
          controlUrl: "https://control.example.com",
          authorization: "Bearer native-service-credential",
        }),
      ).kind,
    ).toBe("valid");
  });
});
