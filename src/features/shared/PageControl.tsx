import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination";

export function PageControl({
  page,
  pages,
  onPage,
  label,
  disabled = false,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Pagination aria-label={label} className="w-auto shrink-0">
      <PaginationContent>
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("pagination.previous")}
            disabled={disabled || page <= 0}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft />
          </Button>
        </PaginationItem>
        <PaginationItem>
          <span aria-live="polite" className="px-1 text-xs text-muted-foreground tabular-nums">
            {page + 1} / {Math.max(pages, 1)}
          </span>
        </PaginationItem>
        <PaginationItem>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("pagination.next")}
            disabled={disabled || page + 1 >= pages}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
