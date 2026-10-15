import type { JsonObject } from "@bufbuild/protobuf";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { object } from "./connection-schema.js";

export function ModelRequestOptions({
  spec,
  onChange,
  disabled,
}: {
  spec: JsonObject;
  onChange: (value: JsonObject) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const openAI = object(spec.openAI);
  const format =
    spec.provider === "Anthropic" ? "messages" : String(openAI.apiFormat ?? "chatCompletions");
  function option(key: string, value: string) {
    const options = { ...openAI };
    if (!value) delete options[key];
    else options[key] = key === "maxCompletionTokens" ? Number(value) : value;
    onChange({ ...spec, openAI: options });
  }
  return (
    <div className="mb-5 space-y-3">
      <div className="space-y-2">
        <Label>{t("management.apiFormat")}</Label>
        <Select
          value={format}
          disabled={disabled}
          onValueChange={(value) =>
            onChange(
              value === "messages"
                ? { provider: "Anthropic", anthropic: object(spec.anthropic) }
                : { provider: "OpenAI", openAI: { ...openAI, apiFormat: value } },
            )
          }
        >
          <SelectTrigger aria-label={t("management.apiFormat")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="responses">Responses</SelectItem>
            <SelectItem value="chatCompletions">Chat Completions</SelectItem>
            <SelectItem value="messages">Anthropic Messages</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {format !== "messages" && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group px-0">
              {t("management.requestOptions")}
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3 pt-2 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="model-token-limit">{t("management.maxTokens")}</Label>
              <Input
                id="model-token-limit"
                type="number"
                min={1}
                step={1}
                disabled={disabled}
                value={String(openAI.maxCompletionTokens ?? "")}
                placeholder={t("management.providerDefault")}
                onChange={(event) => option("maxCompletionTokens", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model-reasoning">{t("management.reasoningEffort")}</Label>
              <Input
                id="model-reasoning"
                disabled={disabled}
                value={String(openAI.reasoningEffort ?? "")}
                placeholder={t("management.providerDefault")}
                onChange={(event) => option("reasoningEffort", event.target.value)}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
