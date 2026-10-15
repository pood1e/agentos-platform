import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { type Pack, PackSchema } from "../../gen/agentos/console/v1/pack_pb.js";

/** Loads a solution pack's presentation from `pack.json`; without a pack the platform defaults apply. */
export function loadPack(dir?: string): Pack {
  if (!dir) return create(PackSchema);
  const pack = fromJsonString(PackSchema, readFileSync(join(dir, "pack.json"), "utf8"));
  const result = createValidator().validate(PackSchema, pack);
  if (result.kind !== "valid") throw new Error(`Invalid pack: ${result.error}`);
  for (const tool of pack.tools) new RegExp(tool.match, "i");
  return pack;
}
