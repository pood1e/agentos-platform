import type { JsonObject } from "@bufbuild/protobuf";
import { useTheme } from "next-themes";
import ReactDiffViewer from "react-diff-viewer-continued";
import { useTranslation } from "react-i18next";
import type { ConfigurationSnapshot } from "../../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { logicalPlatformServer } from "../../../shared/platform-tools.js";

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
function content(value: JsonObject | undefined) {
  if (!value) return "";
  const spec = structuredClone(object(value.spec));
  if (value.kind === "AgentTemplate" && Array.isArray(spec.tools))
    for (const tool of spec.tools) {
      const server = object(object(object(tool).mcp).server);
      if (typeof server.name === "string")
        server.name = logicalPlatformServer(server.name, String(object(value.metadata).name));
    }
  return JSON.stringify(
    value.kind === "ConfigMap"
      ? object(value.data)
      : value.kind === "Secret"
        ? { credential: "[REDACTED]" }
        : spec,
    null,
    2,
  );
}

export function ConfigurationDiff({ snapshot }: { snapshot?: ConfigurationSnapshot }) {
  const { t } = useTranslation(),
    { resolvedTheme } = useTheme();
  if (!snapshot) return null;
  return (
    <div className="space-y-6">
      {snapshot.proposals.map((proposal) => {
        const value = proposal.resource?.value;
        if (!value) return null;
        const name = String(object(value.metadata).name),
          kind = proposal.resource?.kind;
        const previous = snapshot.resources.find(
          (entry) => entry.kind === kind && object(entry.value?.metadata).name === name,
        )?.value;
        return (
          <section key={`${kind}/${name}`} className="min-w-0 overflow-auto">
            <h3 className="mb-2 font-medium">
              {name}{" "}
              <span className="text-xs text-muted-foreground">
                {t(`evaluation.resources.${kind}`, { defaultValue: kind })}
              </span>
            </h3>
            <ReactDiffViewer
              oldValue={content(previous)}
              newValue={proposal.delete ? "" : content(value)}
              splitView={false}
              showDiffOnly
              useDarkTheme={resolvedTheme === "dark"}
              hideLineNumbers
              styles={{
                contentText: { fontSize: 12, lineHeight: 1.6 },
                diffContainer: { width: "100%" },
              }}
            />
          </section>
        );
      })}
    </div>
  );
}
