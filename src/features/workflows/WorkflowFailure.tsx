import { Code, ConnectError } from "@connectrpc/connect";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorKey } from "../../../shared/errors.js";

export function WorkflowFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const key = errorKey(error, "");
  const diagnostic =
    error instanceof ConnectError &&
    [Code.InvalidArgument, Code.FailedPrecondition].includes(error.code)
      ? error.rawMessage
      : error instanceof Error && !(error instanceof ConnectError)
        ? error.message
        : undefined;
  return (
    <Alert variant="destructive">
      <AlertDescription className="whitespace-pre-wrap break-words font-mono text-xs">
        {key ? t(key) : diagnostic || t("management.unavailable")}
      </AlertDescription>
    </Alert>
  );
}
