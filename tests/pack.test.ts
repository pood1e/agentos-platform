import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPack } from "../server/console/pack.js";

function packDir(pack: object) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-pack-"));
  writeFileSync(join(dir, "pack.json"), JSON.stringify(pack));
  return dir;
}

describe("solution pack", () => {
  it("uses platform defaults without a pack", () => {
    const pack = loadPack();
    expect(pack.title).toBe("");
    expect(pack.roles).toEqual([]);
  });

  it("rejects asset paths outside the pack and invalid tool patterns", () => {
    expect(() =>
      loadPack(packDir({ roles: [{ role: "lead", avatar: "../secret.png" }] })),
    ).toThrow();
    expect(() =>
      loadPack(packDir({ tools: [{ match: "(", name: "Broken", icon: "x.svg" }] })),
    ).toThrow();
    expect(() => loadPack(packDir({ title: "x".repeat(41) }))).toThrow(/Invalid pack/);
  });
});
