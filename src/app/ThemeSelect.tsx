import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const themes = [
  { value: "light", label: "theme.light", icon: Sun },
  { value: "dark", label: "theme.dark", icon: Moon },
  { value: "system", label: "theme.system", icon: Monitor },
] as const;

export function ThemeSelect() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const current = themes.find((option) => option.value === theme) ?? themes[2];
  const Icon = current.icon;
  return (
    <Select value={theme ?? "system"} onValueChange={setTheme}>
      <SelectTrigger
        aria-label={t("theme.label")}
        title={t(current.label)}
        className="size-8 justify-center border-transparent p-0 hover:bg-muted [&>svg]:hidden"
      >
        <SelectValue>
          <Icon aria-hidden="true" className="size-4" />
          <span className="sr-only">{t(current.label)}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        {themes.map(({ value, label, icon: Icon }) => (
          <SelectItem key={value} value={value}>
            <Icon className="size-3.5" />
            {t(label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
