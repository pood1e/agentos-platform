import { useMutation } from "@tanstack/react-query";
import { BrainCircuit, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type {
  MemorySearchResult,
  MemorySummary,
} from "../../../gen/kagent/runtime/v1/memory_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { millis } from "../../lib/format.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { KnowledgeArticle } from "./KnowledgeArticle.js";
import { knowledgeDocument } from "./knowledge-content.js";
import { ResourceSheet, SaveButton } from "./ResourceDialog.js";
import { Failure, ResourcePage, useManagementPage } from "./ResourcePage.js";

function AddKnowledge({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const save = useMutation({
    mutationFn: () => managementClient.addKnowledge({ content }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Label htmlFor="knowledge-content">{t("management.knowledgeContent")}</Label>
      <Textarea
        id="knowledge-content"
        rows={18}
        required
        maxLength={24000}
        placeholder={t("management.knowledgePlaceholder")}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <Failure error={save.error} />
      <SaveButton pending={save.isPending} />
    </form>
  );
}

export function KnowledgePage() {
  const { t, i18n } = useTranslation();
  const editable = useCapability(Capability.KNOWLEDGE_MANAGE);
  const [semantic, setSemantic] = useState<MemorySearchResult[]>();
  const list = useManagementPage(
    "knowledge",
    (request, signal) => managementClient.listKnowledge(request, { signal }),
    semantic === undefined,
  );
  const search = useMutation({
    mutationFn: () => managementClient.searchKnowledge({ query: list.search }),
    onSuccess: (result) => setSemantic(result.memories),
  });
  const [viewing, setViewing] = useState<MemorySummary | MemorySearchResult>();
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState<MemorySummary | MemorySearchResult>();
  const records = semantic ?? list.data?.memories ?? [];
  const date = (value?: number, includeTime = true) =>
    value === undefined
      ? "—"
      : includeTime
        ? new Date(value).toLocaleString(i18n.resolvedLanguage)
        : new Date(value).toLocaleDateString(i18n.resolvedLanguage);
  const total = semantic?.length ?? list.data?.totalSize ?? 0;
  const title = t("management.tabs.knowledge");
  const document = viewing && knowledgeDocument(viewing.content);
  return (
    <>
      <ResourcePage
        title={title}
        query={list.search}
        onQuery={(value) => {
          setSemantic(undefined);
          list.onSearch(value);
        }}
        total={total}
        pending={(semantic === undefined && list.isPending) || search.isPending}
        fetching={(semantic === undefined && list.isFetching) || search.isPending}
        error={list.error ?? search.error}
        onRefresh={() => {
          setSemantic(undefined);
          void list.refetch();
        }}
        onAdd={editable ? () => setAdding(true) : undefined}
        page={list.page}
        onPage={list.onPage}
        pagination={semantic === undefined}
        toolbar={
          <>
            <Button
              variant={semantic === undefined ? "outline" : "secondary"}
              disabled={!list.search.trim() || search.isPending}
              onClick={() => search.mutate()}
            >
              <BrainCircuit />
              {t("management.semanticSearch")}
            </Button>
            {semantic !== undefined && (
              <Button variant="ghost" onClick={() => setSemantic(undefined)}>
                {t("management.allKnowledge")}
              </Button>
            )}
            {editable && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("management.clearKnowledge")}
                disabled={!!list.search || semantic !== undefined || !list.data?.totalSize}
                onClick={() => setClearing(true)}
              >
                <Trash2 />
              </Button>
            )}
          </>
        }
      >
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>{t("management.knowledgeContent")}</TableHead>
              <TableHead className="w-24">
                {t(semantic ? "management.similarity" : "management.accessCount")}
              </TableHead>
              <TableHead className="w-44">{t("management.createdAt")}</TableHead>
              <TableHead className="w-16 text-right">{t("management.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((item) => {
              const preview = knowledgeDocument(item.content);
              return (
                <TableRow key={item.id} data-testid="knowledge-row">
                  <TableCell className="py-4">
                    <Button
                      variant="link"
                      className="h-auto w-full max-w-full flex-col items-start gap-1 p-0 text-left font-normal whitespace-normal text-foreground no-underline hover:no-underline"
                      onClick={() => setViewing(item)}
                    >
                      <span className="line-clamp-2 text-sm leading-6 font-medium">
                        {preview.title}
                      </span>
                      {preview.excerpt && (
                        <span className="line-clamp-2 text-xs leading-6 text-muted-foreground">
                          {preview.excerpt}
                        </span>
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {"score" in item
                      ? `${Math.round(item.score * 100)}%`
                      : String(item.accessCount)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {date(millis(item.createdAt), false)}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("management.deleteKnowledge")}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ResourcePage>
      <ResourceSheet
        title={t("management.addKnowledge")}
        open={adding && editable}
        onOpenChange={setAdding}
      >
        {adding && editable && (
          <AddKnowledge
            onSaved={() => {
              setAdding(false);
              setSemantic(undefined);
              void list.refetch();
            }}
          />
        )}
      </ResourceSheet>
      <ResourceSheet
        title={document?.title ?? t("management.knowledgeContent")}
        className="sm:max-w-3xl data-[side=right]:sm:max-w-3xl"
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(undefined);
        }}
      >
        {viewing && document && (
          <div className="space-y-6">
            <p className="border-b pb-4 text-xs text-muted-foreground">
              {t("management.createdAt")} · {date(millis(viewing.createdAt))}
            </p>
            <KnowledgeArticle key={viewing.id} content={document.body} />
          </div>
        )}
      </ResourceSheet>
      {editable && clearing && (
        <ConfirmDelete
          title={t("management.clearKnowledge")}
          description={t("management.clearKnowledgeNotice", {
            count: list.data?.totalSize ?? 0,
          })}
          onClose={() => setClearing(false)}
          onConfirm={async () => {
            await managementClient.clearKnowledge({
              expectedCount: list.data?.totalSize ?? 0,
            });
            setSemantic(undefined);
            list.onSearch("");
            await list.refetch();
          }}
        />
      )}
      {editable && deleting && (
        <ConfirmDelete
          title={t("management.deleteNamed", {
            name: knowledgeDocument(deleting.content).title.slice(0, 80) || deleting.id,
          })}
          description={t("management.deleteKnowledgeNotice")}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await managementClient.deleteKnowledge({ id: deleting.id });
            if (viewing?.id === deleting.id) setViewing(undefined);
            setSemantic((current) => current?.filter((item) => item.id !== deleting.id));
            await list.refetch();
          }}
        />
      )}
    </>
  );
}
