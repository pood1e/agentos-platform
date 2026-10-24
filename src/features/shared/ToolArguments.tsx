import type { JsonValue } from "@bufbuild/protobuf";
import type { Value } from "@bufbuild/protobuf/wkt";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { pretty } from "../../lib/format.js";

function fields(value: JsonValue, path: string[] = []): { path: string; value: JsonValue }[] {
  if (value && typeof value === "object" && Object.keys(value).length) {
    return Object.entries(value).flatMap(([key, item]) =>
      fields(item, [...path, Array.isArray(value) ? String(Number(key) + 1) : key]),
    );
  }
  return [{ path: path.join(" › "), value }];
}

export function ToolArguments({ value }: { value?: Value }) {
  const { t } = useTranslation();
  const raw = pretty(value);
  if (!raw) return <p className="text-xs text-muted-foreground">{t("tool.missingArguments")}</p>;
  let data: JsonValue = raw;
  try {
    data = JSON.parse(raw) as JsonValue;
  } catch {
    // Some tools accept plain text instead of an object.
  }
  return (
    <div className="min-w-0 space-y-2" data-testid="approval-arguments">
      <Table>
        <TableBody>
          {fields(data).map((field) => (
            <TableRow key={field.path}>
              <TableCell className="w-1/4 align-top text-xs whitespace-normal text-muted-foreground wrap-anywhere">
                {field.path || t("tool.arguments")}
              </TableCell>
              <TableCell className="text-xs whitespace-normal">
                <div className="max-h-64 overflow-auto leading-6 whitespace-pre-wrap wrap-anywhere">
                  {field.value === null || typeof field.value === "object"
                    ? "—"
                    : String(field.value)}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group text-xs text-muted-foreground">
            {t("approval.rawArguments")}
            <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre
            data-testid="approval-raw-arguments"
            className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-[11px] leading-5 whitespace-pre-wrap wrap-anywhere"
          >
            {raw}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
