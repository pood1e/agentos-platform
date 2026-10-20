import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { PrepareChangeResponse } from "../../../gen/agentos/governance/v1/change_pb.js";
import { Markdown } from "./Markdown.js";

export function ChangeProposal({ preparation }: { preparation: PrepareChangeResponse }) {
  const { t } = useTranslation();
  const plan = preparation.plan;
  if (!plan) return null;
  return (
    <div className="w-full space-y-3" data-testid="change-proposal">
      <dl className="space-y-2">
        {(["impact", "validation", "rollback"] as const).map((key) => (
          <div key={key}>
            <dt className="font-medium">{t(`operations.plan.${key}`)}</dt>
            <dd className="mt-1 text-muted-foreground">
              <Markdown>{plan[key]}</Markdown>
            </dd>
          </div>
        ))}
      </dl>
      {preparation.simulationReport && (
        <Accordion type="single" collapsible>
          <AccordionItem value="simulation" className="border-0">
            <AccordionTrigger className="py-1 text-xs">
              {t("operations.plan.simulation")}
            </AccordionTrigger>
            <AccordionContent className="space-y-2 text-xs">
              <Markdown>{preparation.simulationReport}</Markdown>
              {plan.simulation?.id && (
                <Link className="text-primary underline" to={`/tasks/${plan.simulation.id}`}>
                  {t("operations.plan.source")}
                </Link>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}
