import { writeFileSync } from "node:fs";
import { administratorRole, allCapabilities, capabilityRole } from "../shared/permissions.js";

writeFileSync(
  "gen/authorization.json",
  `${JSON.stringify({ administratorRole, roles: allCapabilities.map(capabilityRole) }, null, 2)}\n`,
);
