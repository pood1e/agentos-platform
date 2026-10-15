import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const value = i18n.resolvedLanguage === "en" ? "en" : "zh";
  const label = value === "en" ? "English" : "中文";
  return (
    <Select
      value={value}
      onValueChange={(language) => {
        void i18n.changeLanguage(language);
      }}
    >
      <SelectTrigger
        aria-label={t("locale.label")}
        title={label}
        className="size-8 justify-center border-transparent p-0 hover:bg-muted [&>svg]:hidden"
      >
        <SelectValue>
          <Languages aria-hidden="true" className="size-4" />
          <span className="sr-only">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        <SelectItem value="zh">中文</SelectItem>
        <SelectItem value="en">English</SelectItem>
      </SelectContent>
    </Select>
  );
}
