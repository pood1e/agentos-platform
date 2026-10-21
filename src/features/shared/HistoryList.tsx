import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PageControl } from "./PageControl.js";

export const pageSize = 12;

export interface HistoryEntry {
  id: string;
  title: string;
  detail: string;
  status?: ReactNode;
  metadata?: ReactNode;
}

export interface HistoryPage {
  page: number;
  search: string;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
}

/** One page of server-side searched history with a compact selector on small screens. */
export function HistoryList({
  kind,
  entries,
  total,
  paging,
  selectedId,
  selectedTitle,
  onSelect,
  disabled = false,
}: {
  kind: "chat" | "task";
  entries: HistoryEntry[];
  total: number;
  paging: HistoryPage;
  selectedId: string;
  selectedTitle?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const pages = Math.ceil(total / pageSize);
  const title = t(kind === "chat" ? "chat.history" : "task.listTitle");
  const placeholder = t(kind === "chat" ? "chat.noConversations" : "task.noTasks");
  const current = entries.find((entry) => entry.id === selectedId)?.title ?? selectedTitle;
  const pager = (
    <PageControl
      page={paging.page}
      pages={pages}
      onPage={paging.onPage}
      label={t("pagination.label", { title })}
    />
  );
  return (
    <>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          kind === "task" ? "xl:hidden" : "lg:hidden",
        )}
      >
        <Select value={selectedId} onValueChange={onSelect} disabled={disabled || !entries.length}>
          <SelectTrigger aria-label={title} className="min-w-0 flex-1 bg-card">
            <SelectValue placeholder={placeholder}>
              <span className="truncate">{current || placeholder}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
            {entries.map((entry) => (
              <SelectItem
                key={entry.id}
                value={entry.id}
                title={entry.detail}
                className="[&>span:last-child]:min-w-0"
              >
                <span className="truncate">{entry.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pages > 1 && pager}
      </div>
      <Card
        data-testid={`${kind}-history`}
        className={cn(
          "hidden min-h-0 flex-1 gap-0 overflow-hidden py-0 shadow-none",
          kind === "task" ? "xl:flex" : "lg:flex",
        )}
      >
        <CardHeader className="flex shrink-0 flex-row items-center justify-between px-4 py-4">
          <CardTitle className="text-sm">{title}</CardTitle>
          <Badge variant="secondary">{total}</Badge>
        </CardHeader>
        <div className="relative mx-3 mb-3 shrink-0">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label={t(kind === "chat" ? "chat.search" : "task.searchLabel")}
            placeholder={t(kind === "chat" ? "chat.search" : "task.searchPlaceholder")}
            value={paging.search}
            onChange={(event) => {
              paging.onSearch(event.target.value);
              paging.onPage(0);
            }}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
          {entries.map((entry) => (
            <Button
              key={entry.id}
              data-testid="history-entry"
              title={entry.detail}
              variant="ghost"
              disabled={disabled}
              className={cn(
                "h-auto min-h-10 w-full min-w-0 justify-between gap-2 rounded-none border-t border-l-2 border-l-transparent px-3 py-2 text-left",
                kind === "task" && "mx-2 my-1 w-[calc(100%-1rem)] rounded-lg border-0 px-3 py-3",
                entry.id === selectedId &&
                  (kind === "task" ? "bg-muted" : "border-l-primary bg-muted/70"),
              )}
              onClick={() => onSelect(entry.id)}
            >
              <span className="min-w-0 flex-1">
                <strong
                  className={cn(
                    "block font-medium",
                    kind === "task"
                      ? "line-clamp-2 whitespace-normal text-sm leading-5"
                      : "truncate text-xs",
                  )}
                >
                  {entry.title}
                </strong>
                {entry.metadata && (
                  <span className="mt-1 flex min-w-0 flex-wrap gap-1">{entry.metadata}</span>
                )}
              </span>
              {entry.status}
            </Button>
          ))}
          {!entries.length && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              {paging.search ? t("task.noMatches") : placeholder}
            </p>
          )}
        </ScrollArea>
        {pages > 1 && <div className="flex shrink-0 justify-center border-t p-2">{pager}</div>}
      </Card>
    </>
  );
}
