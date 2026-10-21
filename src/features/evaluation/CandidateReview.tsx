import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CandidateState } from "../../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { can, publicationCapabilities } from "../../../shared/permissions.js";
import { useAccess } from "../../lib/access.js";
import { evaluationClient } from "../../lib/console.js";
import { ResourceSheet } from "../management/ResourceDialog.js";
import { Failure } from "../management/ResourcePage.js";
import { ConfigurationDiff } from "./ConfigurationDiff.js";
import { CandidateStatus, useCandidateName } from "./candidate.js";
import { EvaluationResults } from "./EvaluationResults.js";

export function CandidateReview({
  id,
  close,
  refreshed,
}: {
  id: string;
  close: () => void;
  refreshed: () => void;
}) {
  const { t } = useTranslation(),
    name = useCandidateName();
  const access = useAccess();
  const detail = useQuery({
    queryKey: ["evaluation", id],
    queryFn: ({ signal }) => evaluationClient.getCandidate({ id }, { signal }),
    enabled: !!id,
    refetchInterval: 3_000,
  });
  const candidate = detail.data?.candidate,
    baseline = detail.data?.snapshot?.baseline;
  const canPublish =
    !!detail.data?.snapshot &&
    publicationCapabilities(detail.data.snapshot.proposals).every((capability) =>
      can(access.data, capability),
    );
  const command = useMutation({
    mutationFn: async (publish: boolean) => {
      const response = await (publish
        ? evaluationClient.publishCandidate({ id, bindingDigest: candidate?.bindingDigest })
        : evaluationClient.runEvaluation({ id }));
      return response.candidate;
    },
    onSuccess: () => {
      void detail.refetch();
      refreshed();
    },
  });
  return (
    <ResourceSheet
      open={!!id}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={candidate ? name(candidate.name) : t("evaluation.title")}
      className="data-[side=right]:sm:max-w-4xl"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <Failure error={detail.error ?? command.error} />
        {candidate && (
          <>
            <div className="flex items-center gap-3">
              <CandidateStatus state={candidate.state} />
              <span className="text-sm text-muted-foreground">
                {candidate.baseline} · {candidate.baselineVersion}
              </span>
              <div className="ml-auto flex gap-2">
                {candidate.state === CandidateState.DRAFT && (
                  <Button
                    size="sm"
                    disabled={command.isPending}
                    onClick={() => command.mutate(false)}
                  >
                    <Play />
                    {t("evaluation.run")}
                  </Button>
                )}
                {[CandidateState.PASSED, CandidateState.PUBLISHING].includes(candidate.state) && (
                  <Button
                    size="sm"
                    disabled={
                      !canPublish ||
                      command.isPending ||
                      candidate.state === CandidateState.PUBLISHING
                    }
                    onClick={() => command.mutate(true)}
                  >
                    <Upload />
                    {t("evaluation.publish")}
                  </Button>
                )}
              </div>
            </div>
            {candidate.state === CandidateState.PASSED && !canPublish && (
              <p className="text-sm text-muted-foreground">
                {t("evaluation.resourcePermissionRequired")}
              </p>
            )}
            {!!candidate.failures.length && (
              <ul className="space-y-1 text-sm text-destructive">
                {candidate.failures.map((failure) => (
                  <li key={failure}>{t(failure)}</li>
                ))}
              </ul>
            )}
            <Tabs defaultValue="changes" className="min-h-0 flex-1">
              <TabsList>
                <TabsTrigger value="changes">{t("evaluation.changes")}</TabsTrigger>
                <TabsTrigger value="results">{t("evaluation.results")}</TabsTrigger>
              </TabsList>
              <TabsContent value="changes">
                <ConfigurationDiff snapshot={detail.data?.snapshot} />
              </TabsContent>
              <TabsContent value="results" className="space-y-4">
                <EvaluationResults report={candidate.report} baseline={baseline} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </ResourceSheet>
  );
}
