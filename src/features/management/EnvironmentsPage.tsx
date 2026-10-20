import { useQuery } from "@connectrpc/connect-query";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Governance } from "../../../gen/agentos/governance/v1/governance_pb.js";
import { ManagementService } from "../../../gen/agentos/management/v1/management_pb.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { Failure } from "./ResourcePage.js";

function ExternalLink({ name, url, label = name }: { name: string; url: string; label?: string }) {
  return (
    <Button variant="link" size="sm" asChild>
      <a href={url} aria-label={label} target="_blank" rel="noreferrer">
        <ToolIcon name={name} className="size-6 border-0 bg-transparent" />
        {label}
        <ArrowUpRight />
      </a>
    </Button>
  );
}

export function EnvironmentsPage() {
  const { t } = useTranslation();
  const result = useQuery(ManagementService.method.listEnvironments, {});
  return (
    <section className="space-y-4" data-testid="environments-page">
      <h1 className="text-xl font-semibold tracking-tight">{t("management.tabs.environments")}</h1>
      <Failure error={result.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("operations.environment")}</TableHead>
            <TableHead>{t("operations.governance")}</TableHead>
            <TableHead>{t("operations.links")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.data?.environments.map((environment) => (
            <TableRow key={environment.name}>
              <TableCell>{environment.name}</TableCell>
              <TableCell>
                {t(
                  environment.governance === Governance.APPROVAL
                    ? "operations.human"
                    : "operations.none",
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-3">
                  {environment.links.map((link) => (
                    <ExternalLink key={link.name} name={link.name} url={link.url} />
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
