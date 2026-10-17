import { timestampMs } from "@bufbuild/protobuf/wkt";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { evaluationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";
import { CandidateReview } from "./CandidateReview.js";
import { CandidateStatus, useCandidateName } from "./candidate.js";

export function EvaluationsPage() {
  const { t, i18n } = useTranslation(),
    name = useCandidateName();
  const [search, setSearch] = useSearchParams(),
    id = search.get("candidate") ?? "";
  const list = useQuery({
    queryKey: ["evaluation"],
    queryFn: ({ signal }) => evaluationClient.listCandidates({}, { signal }),
    refetchInterval: 3_000,
  });
  const candidates = [...(list.data?.candidates ?? [])].sort(
    (a, b) =>
      (b.createdAt ? timestampMs(b.createdAt) : 0) - (a.createdAt ? timestampMs(a.createdAt) : 0),
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label={t("evaluation.title")}>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("evaluation.title")}</h1>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("management.refresh")}
          onClick={() => void list.refetch()}
        >
          <RefreshCw />
        </Button>
      </div>
      <Failure error={list.error} />
      <div className="min-h-0 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("evaluation.configuration")}</TableHead>
              <TableHead>{t("evaluation.baseline")}</TableHead>
              <TableHead>{t("evaluation.createdAt")}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("evaluation.status")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.map((candidate) => (
              <TableRow
                key={candidate.id}
                className="cursor-pointer"
                onClick={() => setSearch({ candidate: candidate.id })}
              >
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto p-0 font-medium"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSearch({ candidate: candidate.id });
                    }}
                  >
                    {name(candidate.name)}
                  </Button>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {candidate.baseline} · {candidate.baselineVersion}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {candidate.createdAt
                    ? new Date(timestampMs(candidate.createdAt)).toLocaleString(
                        i18n.resolvedLanguage,
                      )
                    : "—"}
                </TableCell>
                <TableCell>
                  <CandidateStatus state={candidate.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!candidates.length && !list.isPending && (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("evaluation.empty")}</p>
        )}
      </div>
      <CandidateReview id={id} close={() => setSearch({})} refreshed={() => void list.refetch()} />
    </section>
  );
}
