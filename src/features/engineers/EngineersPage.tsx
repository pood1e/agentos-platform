import { useQuery } from "@connectrpc/connect-query";
import { Plus, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import { errorKey } from "../../../shared/errors.js";
import { useCapability } from "../../lib/access.js";
import { RoleEditor } from "./RoleEditor.js";
import { Team } from "./Team.js";

export function EngineersPage() {
  const { t } = useTranslation();
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const engineers = useQuery(ConsoleService.method.listEngineers, {}, { refetchInterval: 3_000 });
  const configuration = useQuery(ConsoleService.method.getConfiguration, {});
  const error = configuration.error ?? engineers.error;
  const [editor, setEditor] = useState(false);
  const [selected, setSelected] = useState<RoleDefinition>();
  const [selectedEngineer, setSelectedEngineer] = useState<string>();
  const opener = useRef<HTMLButtonElement>(null);
  const configure = (
    role: RoleDefinition | undefined,
    trigger: HTMLButtonElement,
    engineer?: string,
  ) => {
    opener.current = trigger;
    setSelected(role);
    setSelectedEngineer(engineer);
    setEditor(true);
  };
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      <div className="flex items-center justify-between gap-3 py-1">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {t("configuration.title")}
        </h1>
        {editable && (
          <Button
            disabled={!configuration.data}
            onClick={(event) => configure(undefined, event.currentTarget)}
          >
            <Plus />
            {t("configuration.newRole")}
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex w-full items-center justify-between gap-3">
            {t(errorKey(error, "configuration.unavailable"))}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("configuration.refresh")}
              onClick={() => void Promise.all([configuration.refetch(), engineers.refetch()])}
            >
              <RefreshCw />
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Team
        engineers={engineers.data?.engineers ?? []}
        roles={configuration.data?.roles ?? []}
        tools={configuration.data?.engineerTools ?? []}
        loading={engineers.isPending || (engineers.isError && !engineers.data)}
        onConfigure={configure}
      />
      <Sheet open={editor} onOpenChange={setEditor}>
        {editor && configuration.data && (
          <RoleEditor
            key={selected?.name ?? "new"}
            role={selected}
            engineer={selectedEngineer}
            configuration={configuration.data}
            onReturnFocus={() => opener.current?.focus()}
            onRuntimeApplied={() => {
              void configuration.refetch();
              void engineers.refetch();
            }}
            onSaved={() => {
              setEditor(false);
              void configuration.refetch();
              void engineers.refetch();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}
