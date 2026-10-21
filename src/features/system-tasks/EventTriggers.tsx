import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { automationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";
import { roleLabel } from "../shared/engineers.js";

export function EventTriggers() {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ["event-triggers"],
    queryFn: ({ signal }) => automationClient.listEventTriggers({}, { signal }),
  });
  if (!list.error && !list.data?.eventTriggers.length) return null;
  return (
    <section className="space-y-3" aria-label={t("automation.eventTriggers")}>
      <h2 className="text-base font-semibold">{t("automation.eventTriggers")}</h2>
      <Failure error={list.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("automation.name")}</TableHead>
            <TableHead>{t("automation.agent")}</TableHead>
            <TableHead>{t("automation.environment")}</TableHead>
            <TableHead>{t("automation.eventIngress")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.eventTriggers.map(({ trigger, environment, ingressEnabled }) => (
            <TableRow
              key={`${environment}/${trigger?.eventNamespace}`}
              data-testid="event-trigger-row"
            >
              <TableCell>
                <p>
                  {t(`automation.eventNames.${trigger?.eventNamespace}`, {
                    defaultValue: trigger?.eventNamespace ?? "",
                  })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{trigger?.source?.typePrefix}*</p>
              </TableCell>
              <TableCell>{roleLabel(trigger?.agent?.name ?? "")}</TableCell>
              <TableCell>{environment}</TableCell>
              <TableCell>
                <Badge variant="outline">
                  {t(ingressEnabled ? "automation.ingressEnabled" : "automation.ingressDisabled")}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">{t("automation.eventHint")}</p>
    </section>
  );
}
