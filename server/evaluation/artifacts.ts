import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJsonString, type JsonObject } from "@bufbuild/protobuf";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { LRUCache } from "lru-cache";
import {
  type ArtifactContent,
  ArtifactContentSchema,
  type ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { SkillCatalogSchema } from "../../gen/agentos/management/v1/management_pb.js";
import { skillSource } from "../console/role-template.js";
import { meta } from "../management/native.js";
import { object, text } from "../read-model/decode/messages.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const artifact = (source: string, version: string, path: string, sha256: string) =>
  create(ArtifactContentSchema, { source, version, path, sha256 });

/** Content-addressed OCI artifacts and actual Git blobs are bound before a candidate exists. */
export function configurationArtifacts(gitOrigins: ReadonlySet<string>) {
  const cache = new LRUCache<string, ArtifactContent[]>({ max: 32 });
  async function gitArtifacts(
    url: string,
    commit: string,
    path: string,
  ): Promise<ArtifactContent[]> {
    if (!gitOrigins.has(new URL(url).origin) || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Skills require an allowed Git origin and immutable commit");
    const key = `${url}\0${commit}\0${path}`;
    const known = cache.get(key);
    if (known) return known;
    const dir = await mkdtemp(join(tmpdir(), "agentos-skill-"));
    try {
      await git.init({ fs, dir });
      await git.fetch({
        fs,
        http,
        dir,
        url,
        ref: commit,
        depth: 1,
        singleBranch: true,
        tags: false,
      });
      const entries: ReturnType<typeof artifact>[] = [];
      let bytes = 0;
      async function walk(filepath: string) {
        const { tree } = await git.readTree({
          fs,
          dir,
          oid: commit,
          ...(filepath ? { filepath } : {}),
        });
        for (const entry of tree) {
          const name = filepath ? `${filepath}/${entry.path}` : entry.path;
          if (entry.type === "tree") await walk(name);
          else if (entry.type === "blob" && entry.mode !== "120000") {
            const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
            bytes += blob.byteLength;
            if (bytes > 8 * 1024 * 1024 || entries.length >= 1000)
              throw new Error("Skill content exceeds the candidate limit");
            entries.push(artifact(url, commit, name, hash(blob)));
          } else throw new Error("Skills cannot contain links or submodules");
        }
      }
      await walk(path);
      if (!entries.length) throw new Error("Skill source is empty");
      cache.set(key, entries);
      return entries;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return async (native: JsonObject[], proposals: ResourceProposal[]) => {
    const versions = new Map<string, ReturnType<typeof artifact>>();
    const put = (entry: ReturnType<typeof artifact>) =>
      versions.set(`${entry.source}\0${entry.version}\0${entry.path}`, entry);
    for (const value of [
      ...native,
      ...proposals.flatMap((proposal) =>
        proposal.resource?.value ? [proposal.resource.value] : [],
      ),
    ]) {
      const spec = object(value.spec);
      if (value.kind === "Harness") {
        const image = text(object(spec.workload).image);
        const digest = /@sha256:([a-f0-9]{64})$/.exec(image)?.[1];
        if (!digest) throw new Error("Evaluation requires immutable harness images");
        put(artifact(image, `sha256:${digest}`, "", digest));
      }
      if (value.kind === "Agent") {
        const revision = text(object(value.status).desiredRevision);
        if (revision)
          put(
            artifact(
              `kagent-runtime://${text(meta(value).namespace)}/${text(meta(value).name)}`,
              revision,
              "",
              revision,
            ),
          );
      }
      const skills =
        value.kind === "AgentTemplate" && Array.isArray(spec.skills)
          ? spec.skills
          : value.kind === "ConfigMap" && typeof object(value.data)["catalog.json"] === "string"
            ? fromJsonString(
                SkillCatalogSchema,
                text(object(value.data)["catalog.json"]),
              ).items.flatMap((item) => (item.skill ? [{ source: skillSource(item.skill) }] : []))
            : [];
      for (const skill of skills) {
        const source = object(object(skill).source),
          path = text(source.path);
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw new Error("Skill path is invalid");
        if (source.git) {
          const ref = object(source.git);
          for (const entry of await gitArtifacts(text(ref.url), text(ref.commit), path)) put(entry);
        } else if (source.oci) {
          const image = text(source.oci),
            digest = /@sha256:([a-f0-9]{64})$/.exec(image)?.[1];
          if (!digest) throw new Error("Skills require an immutable OCI digest");
          put(artifact(image, `sha256:${digest}`, path, digest));
        } else throw new Error("Skill source needs a configured immutable artifact reader");
      }
    }
    return [...versions.values()].sort((a, b) =>
      `${a.source}/${a.version}/${a.path}`.localeCompare(`${b.source}/${b.version}/${b.path}`),
    );
  };
}
