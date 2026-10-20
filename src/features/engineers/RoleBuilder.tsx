import { equals } from "@bufbuild/protobuf";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
} from "../../../gen/agentos/console/v1/role_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { useAccess } from "../../lib/access.js";
import { ChatComposer } from "../chat/ChatComposer.js";
import { ConversationRuntime } from "../chat/ConversationRuntime.js";
import { useChat } from "../chat/use-chat.js";

/** Builder conversation whose latest prepared role fills the editor form. */
export function RoleBuilder({ onDraft }: { onDraft: (draft: RoleDefinition) => void }) {
  const { t } = useTranslation();
  const [contextId, setContext] = useState("");
  const access = useAccess();
  const chat = useChat(
    { namespace: access.data?.workspace ?? "", name: "role-builder" },
    contextId,
    setContext,
  );
  const applied = useRef<RoleDefinition>(undefined);
  const draft = chat.conversation?.roleDraft;
  useEffect(() => {
    if (!draft || (applied.current && equals(RoleDefinitionSchema, applied.current, draft))) return;
    applied.current = draft;
    onDraft(draft);
  }, [draft, onDraft]);
  return (
    <section data-testid="role-builder">
      <ConversationRuntime key={contextId} chat={chat}>
        <ChatComposer chat={chat} builder />
      </ConversationRuntime>
      {(chat.sending || chat.busy) && (
        <p
          role="status"
          className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
          {t("configuration.generating")}
        </p>
      )}
      {chat.conversation?.state === ActivityState.FAILED && (
        <Alert variant="destructive" className="mx-4 mb-4 w-auto">
          <AlertDescription>{t("configuration.buildFailed")}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
