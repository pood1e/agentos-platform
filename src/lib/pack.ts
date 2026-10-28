import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { useQuery } from "@tanstack/react-query";
import { type Pack, PackSchema } from "../../gen/agentos/console/v1/pack_pb.js";
import i18n from "../i18n/index.js";

const platform = create(PackSchema);
const applied = new WeakSet<Pack>();

export const packAsset = (path: string) => `/pack/${path}`;

/** Reads `pack.json`; tool brands whose pattern does not compile are skipped. */
export function parsePack(json: JsonValue): Pack {
  const pack = fromJson(PackSchema, json);
  pack.tools = pack.tools.filter((tool) => {
    try {
      new RegExp(tool.match, "i");
      return true;
    } catch {
      return false;
    }
  });
  return pack;
}

/** The console host serves the pack image's files; without a pack the platform defaults apply. */
async function fetchPack() {
  const response = await fetch(packAsset("pack.json"));
  if (response.status === 404) return platform;
  if (!response.ok) throw new Error(`Solution pack unavailable (${response.status})`);
  return parsePack(await response.json());
}

/** Merges a pack's i18next resources over the platform resources, namespace by namespace. */
export function applyPackLocales(pack: Pack) {
  if (applied.has(pack)) return;
  applied.add(pack);
  for (const [language, namespaces] of Object.entries(pack.locales))
    for (const [namespace, resources] of Object.entries(namespaces))
      if (resources && typeof resources === "object" && !Array.isArray(resources))
        i18n.addResourceBundle(language, namespace, resources, true, true);
}

/** The solution pack's presentation, or the platform defaults until it loads. */
export function usePack(): Pack {
  const { data } = useQuery({
    queryKey: ["pack"],
    queryFn: fetchPack,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data ?? platform;
}
