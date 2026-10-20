import { useMutation } from "@connectrpc/connect-query";
import { LoaderCircle, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { useAccess } from "../../lib/access.js";
import { errorKey } from "../../lib/errors.js";

export function StopTask({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const access = useAccess();
  const cancel = useMutation(ConsoleService.method.cancelTask, {
    onSuccess: () => toast.success(t("task.cancelledHint")),
    onError: (error) => toast.error(t(errorKey(error, "task.cancelFailed"))),
  });
  if (!access.data?.operate) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={cancel.isPending}
      title={t("task.cancelHint")}
      onClick={() => cancel.mutate({ taskId })}
    >
      {cancel.isPending ? <LoaderCircle className="animate-spin" /> : <Square />}
      {t("task.stop")}
    </Button>
  );
}
