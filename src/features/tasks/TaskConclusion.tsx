import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "../shared/Markdown.js";

export function TaskConclusion({
  answer,
  collaborative,
}: {
  answer: string;
  collaborative: boolean;
}) {
  const { t } = useTranslation();
  const content = <Markdown>{answer}</Markdown>;
  return collaborative ? (
    <Card className="shrink-0 gap-2 py-3 shadow-none" data-testid="task-result">
      <CardHeader className="px-4 py-0">
        <CardTitle className="text-sm">{t("task.conclusion")}</CardTitle>
      </CardHeader>
      <CardContent className="max-h-[18dvh] overflow-y-auto px-4">{content}</CardContent>
    </Card>
  ) : (
    <ScrollArea className="min-h-0 flex-1" data-testid="task-result">
      <div className="px-1 pb-4">{content}</div>
    </ScrollArea>
  );
}
