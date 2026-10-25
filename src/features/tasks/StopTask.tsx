import { useMutation } from "@connectrpc/connect-query";
import { LoaderCircle, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { errorKey } from "../../../shared/errors.js";

export function StopTask({ taskId, operate }: { taskId: string; operate: boolean }) {
  const { t } = useTranslation();
  const cancel = useMutation(ConsoleService.method.cancelTask, {
    onSuccess: () => toast.success(t("task.cancelledHint")),
    onError: (error) => toast.error(t(errorKey(error, "task.cancelFailed"))),
  });
  if (!operate) return null;
  return (
    <Button
      type="button"
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
