import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

export function TagBadges({ tags, compact = false }: { tags: string[]; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {(compact ? tags.slice(0, 2) : tags).map((tag) => {
        const name = t(`task.tagNames.${tag}`, { defaultValue: tag, nsSeparator: false });
        return (
          <Badge key={tag} variant="secondary" title={name} className="max-w-full">
            <span className="truncate">{name}</span>
          </Badge>
        );
      })}
      {compact && tags.length > 2 && <Badge variant="outline">+{tags.length - 2}</Badge>}
    </>
  );
}
