import i18n, { tr } from "../../i18n/index.js";

/** Localized name and purpose for known tools; other tools keep their reported name. */
export function toolText(name: string, description = "") {
  const candidates = [name, name.split("__").at(-1) ?? name, name.split(/[.:/]/).at(-1) ?? name]
    .map((candidate) => candidate.replace(/[.:/]/g, "_"))
    .flatMap((candidate) => {
      const parts = candidate.split("_");
      return parts.map((_, index) => parts.slice(index).join("_"));
    });
  const key = candidates.find((candidate) => i18n.exists(`tools:catalog.${candidate}.name`));
  return key
    ? { name: tr(`tools:catalog.${key}.name`), description: tr(`tools:catalog.${key}.description`) }
    : { name, description };
}

export function toolServerLabel(ref: string) {
  const name = ref.split("/").at(-1) ?? ref;
  const key = `tools:servers.${name}`;
  return i18n.exists(key) ? tr(key) : name.replace(/[-_]/g, " ");
}
