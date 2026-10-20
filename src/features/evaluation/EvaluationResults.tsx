import { ExternalLink } from "lucide-react";
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
import type {
  EvaluationBaseline,
  EvaluationReport,
} from "../../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { ruleSummaries, scoreRuleFailures } from "../../../shared/evaluation.js";

function TraceLink({
  href,
  label,
  variant = "link",
}: {
  href: string;
  label: string;
  variant?: "link" | "outline";
}) {
  if (!/^https?:\/\//i.test(href)) return null;
  return (
    <Button
      variant={variant}
      size="sm"
      asChild
      className={variant === "link" ? "h-auto p-0 text-xs" : undefined}
    >
      <a href={href} target="_blank" rel="noreferrer">
        {label}
        <ExternalLink />
      </a>
    </Button>
  );
}

const number = (value?: number) => (value === undefined ? "—" : value.toFixed(2));

export function EvaluationResults({
  report,
  baseline,
}: {
  report?: EvaluationReport;
  baseline?: EvaluationBaseline;
}) {
  const { t } = useTranslation();
  if (!report) return <p className="text-sm text-muted-foreground">{t("evaluation.noReport")}</p>;
  const metricName = (name: string) => t(`evaluation.metrics.${name}`, { defaultValue: name });
  return (
    <div className="space-y-4">
      {report.experimentUrl && (
        <TraceLink href={report.experimentUrl} label="Langfuse" variant="outline" />
      )}
      {report.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(report.error)}
        </p>
      )}
      {baseline && (
        <section aria-label={t("evaluation.ruleSummary")}>
          <h3 className="mb-2 text-sm font-medium">{t("evaluation.ruleSummary")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "rule",
                  "candidateMean",
                  "releasedMean",
                  "delta",
                  "threshold",
                  "maximumRegression",
                  "verdict",
                ].map((key) => (
                  <TableHead key={key}>{t(`evaluation.${key}`)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ruleSummaries(baseline, report).map((row) => (
                <TableRow key={row.rule.name}>
                  <TableCell>{metricName(row.rule.name)}</TableCell>
                  <TableCell>{number(row.candidate)}</TableCell>
                  <TableCell>{number(row.released)}</TableCell>
                  <TableCell
                    className={row.delta !== undefined && row.delta < 0 ? "text-destructive" : ""}
                  >
                    {row.delta !== undefined && row.delta > 0 ? "+" : ""}
                    {number(row.delta)}
                  </TableCell>
                  <TableCell>≥ {number(row.rule.minimum)}</TableCell>
                  <TableCell>≤ {number(row.rule.maximumRegression)}</TableCell>
                  <TableCell
                    className={row.failures.length ? "text-destructive" : "text-emerald-600"}
                  >
                    {row.failures.length
                      ? row.failures.map((failure) => t(failure)).join(" · ")
                      : t("evaluation.states.passed")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">{t("evaluation.ruleVerdictHint")}</p>
        </section>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("evaluation.sample")}</TableHead>
            <TableHead>{t("evaluation.round")}</TableHead>
            {baseline?.rules.map((rule) => (
              <TableHead key={rule.name}>{metricName(rule.name)}</TableHead>
            ))}
            <TableHead>{t("evaluation.traces")}</TableHead>
            <TableHead>{t("evaluation.error")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.samples.map((row) => (
            <TableRow key={`${row.sampleId}:${row.repetition}`}>
              <TableCell>
                {baseline?.samples.find((sample) => sample.id === row.sampleId)?.name ||
                  row.sampleId}
              </TableCell>
              <TableCell>{row.repetition}</TableCell>
              {baseline?.rules.map((rule) => (
                <TableCell key={rule.name} className="font-mono text-xs">
                  <span className={scoreRuleFailures(rule, row).length ? "text-destructive" : ""}>
                    {number(row.candidate.find((score) => score.name === rule.name)?.value)}
                  </span>{" "}
                  / {number(row.released.find((score) => score.name === rule.name)?.value)}
                </TableCell>
              ))}
              <TableCell className="space-x-2 text-xs">
                <TraceLink href={row.candidateTraceUrl} label={t("evaluation.candidateTrace")} />
                <TraceLink href={row.releasedTraceUrl} label={t("evaluation.releasedTrace")} />
              </TableCell>
              <TableCell className="max-w-60 whitespace-normal text-xs text-destructive">
                {row.error ? t(row.error) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">{t("evaluation.scoreOrder")}</p>
    </div>
  );
}
