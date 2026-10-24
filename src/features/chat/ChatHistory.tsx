import { History, MoreHorizontal, Search, SquarePen, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { ConversationSummary } from "../../../gen/agentos/console/v1/conversation_pb.js";
import { consoleClient } from "../../lib/console.js";
import { cn } from "../../lib/utils.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { PageControl } from "../shared/PageControl.js";
import { type HistoryPage, pageSize } from "../shared/paging.js";
import { active, awaiting } from "../status/activity.js";
import { Status } from "../status/Status.js";

export function ChatHistory({
  entries,
  total,
  paging,
  selectedId,
  disabled,
  onSelect,
  onNew,
  onDeleted,
  onRefresh,
}: {
  entries: ConversationSummary[];
  total: number;
  paging: HistoryPage;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<ConversationSummary>();
  const select = (id: string) => {
    setOpen(false);
    onSelect(id);
  };
  const create = () => {
    setOpen(false);
    onNew();
  };
  const pages = Math.ceil(total / pageSize);
  const contents = (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-3">
        <h2 className="text-sm font-medium">{t("chat.history")}</h2>
        <Badge variant="secondary">{total}</Badge>
      </div>
      <div className="space-y-3 px-3 pb-3">
        <Button
          variant="outline"
          className="w-full justify-start"
          disabled={disabled}
          onClick={create}
        >
          <SquarePen />
          {t("chat.new")}
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label={t("chat.search")}
            placeholder={t("chat.search")}
            value={paging.search}
            onChange={(event) => paging.onSearch(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <ul className="space-y-1 px-2 pb-2">
          {entries.map((entry) => {
            const busy = active(entry.state) || awaiting(entry.state);
            const title = entry.title || t("chat.title");
            return (
              <li
                key={entry.contextId}
                data-testid="history-row"
                data-context-id={entry.contextId}
                className={cn(
                  "group flex min-w-0 items-center rounded-lg hover:bg-muted/60",
                  entry.contextId === selectedId && "bg-muted",
                )}
              >
                <Button
                  data-testid="history-entry"
                  title={title}
                  variant="ghost"
                  disabled={disabled}
                  aria-current={entry.contextId === selectedId ? "page" : undefined}
                  className="h-auto min-w-0 flex-1 flex-col items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-transparent"
                  onClick={() => select(entry.contextId)}
                >
                  <span className="block w-full truncate text-[13px] font-medium">{title}</span>
                  <Status state={entry.state} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mr-1 shrink-0 text-muted-foreground"
                      disabled={disabled}
                      aria-label={t("chat.conversationActions")}
                      title={t("chat.conversationActions")}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={busy}
                      onSelect={() => setRemoving(entry)}
                    >
                      <Trash2 />
                      {t("chat.delete")}
                    </DropdownMenuItem>
                    {busy && (
                      <p className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
                        {t("chat.deleteBusy")}
                      </p>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
        {!entries.length && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t(paging.search ? "task.noMatches" : "chat.noConversations")}
          </p>
        )}
      </ScrollArea>
      {pages > 1 && (
        <div className="flex shrink-0 justify-center border-t p-2">
          <PageControl
            page={paging.page}
            pages={pages}
            onPage={paging.onPage}
            label={t("pagination.label", { title: t("chat.history") })}
            disabled={disabled}
          />
        </div>
      )}
    </>
  );
  return (
    <>
      <Card
        data-testid="chat-history"
        className="hidden min-h-0 flex-1 gap-0 overflow-hidden py-0 shadow-none lg:flex"
      >
        {contents}
      </Card>
      <div className="flex min-w-0 lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="min-w-0" aria-label={t("chat.history")}>
              <History />
              {t("chat.history")}
              <Badge variant="secondary">{total}</Badge>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-[min(320px,calc(100vw-2rem))] gap-0 p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("chat.history")}</SheetTitle>
              <SheetDescription>{t("chat.search")}</SheetDescription>
            </SheetHeader>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2"
                aria-label={t("common.close")}
              >
                <X />
              </Button>
            </SheetClose>
            {contents}
          </SheetContent>
        </Sheet>
      </div>
      {removing && (
        <ConfirmDelete
          title={t("chat.delete")}
          description={t("chat.deleteConfirm", { title: removing.title || t("chat.title") })}
          onConfirm={async () => {
            await consoleClient.deleteSession({ sessionId: removing.contextId });
            onDeleted(removing.contextId);
            if (entries.length === 1 && paging.page > 0) paging.onPage(paging.page - 1);
            await onRefresh();
          }}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </>
  );
}
