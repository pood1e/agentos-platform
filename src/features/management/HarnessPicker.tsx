import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Harness } from "../../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import { object } from "./connection-schema.js";

export const harnessName = (harness: Harness) => harness.ref?.name ?? "";
export const runtimeName = (runtime: string) =>
  ({ kagent: "kagent", codex: "Codex", claude: "Claude Code", byo: "BYO" })[runtime] ?? runtime;
export const harnessMetadata = (harness: Harness) => object(harness.resource?.value?.metadata);

export function HarnessPicker({
  harnesses,
  value,
  onChange,
  disabled = false,
}: {
  harnesses: Harness[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label>{t("harness.label")}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={t("harness.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {harnesses.map((harness) => {
            const name = harnessName(harness);
            const label = String(
              object(harnessMetadata(harness).annotations)["agentos.dev/display-name"] ||
                t(`harness.presets.${name}`, { defaultValue: name }),
            );
            return (
              <SelectItem key={name} value={name}>
                {label} · {runtimeName(harness.runtime)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
