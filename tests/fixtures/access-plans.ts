import { inject } from "vitest";
import type { AccessPlan } from "../../server/governance/access-plans.js";

export const fixturePlans = () => JSON.parse(inject("accessPlans")) as AccessPlan[];
