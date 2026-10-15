import { create } from "@bufbuild/protobuf";
import { useQuery } from "@connectrpc/connect-query";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { type Pack, PackSchema } from "../../gen/agentos/console/v1/pack_pb.js";
import i18n from "../i18n/index.js";

const platform = create(PackSchema);
const applied = new WeakSet<Pack>();

export const packAsset = (path: string) => `/pack/${path}`;

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
  const { data } = useQuery(
    ConsoleService.method.getPack,
    {},
    { staleTime: Number.POSITIVE_INFINITY },
  );
  return data?.pack ?? platform;
}
