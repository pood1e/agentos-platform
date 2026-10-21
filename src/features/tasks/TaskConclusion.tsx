import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Markdown } from "../shared/Markdown.js";

export function TaskConclusion({ answer }: { answer: string }) {
  const { t } = useTranslation();
  return (
    <Card className="shrink-0 gap-2 py-3 shadow-none" data-testid="task-result">
      <CardHeader className="px-4 py-0">
        <CardTitle className="text-sm">{t("task.conclusion")}</CardTitle>
      </CardHeader>
      <CardContent className="max-h-[18dvh] overflow-y-auto px-4">
        <Markdown>{answer}</Markdown>
      </CardContent>
    </Card>
  );
}
