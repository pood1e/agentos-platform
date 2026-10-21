import { ChevronDown, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Markdown } from "../shared/Markdown.js";

export function TaskConclusion({ answer }: { answer: string }) {
  const { t } = useTranslation();
  return (
    <Collapsible asChild>
      <Card className="shrink-0 gap-0 py-0 shadow-none" data-testid="task-result">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="group h-11 w-full justify-start px-4 text-sm">
            <FileText />
            {t("task.conclusion")}
            <ChevronDown className="ml-auto transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="max-h-[24dvh] overflow-y-auto border-t px-4 py-3">
            <Markdown>{answer}</Markdown>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
