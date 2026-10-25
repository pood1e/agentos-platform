import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorKey } from "../../../shared/errors.js";
import { PageControl } from "../shared/PageControl.js";

export const pageSize = 12;
interface PageRequest {
  pageSize: number;
  pageToken: string;
  query: string;
}
interface PageResult {
  totalSize: number;
  nextPageToken: string;
}

export function useManagementPage<T extends PageResult>(
  scope: string,
  fetch: (request: PageRequest, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const [tokens, setTokens] = useState([""]);
  const [page, setPage] = useState(0);
  const result = useQuery({
    queryKey: ["management", scope, query, tokens[page]],
    queryFn: ({ signal }) => fetch({ pageSize, pageToken: tokens[page], query }, signal),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === scope ? previous : undefined,
    enabled,
  });
  useEffect(() => {
    if (!result.data || result.isPlaceholderData) return;
    const lastPage = Math.max(0, Math.ceil(result.data.totalSize / pageSize) - 1);
    if (page > lastPage) setPage(lastPage);
  }, [result.data, result.isPlaceholderData, page]);
  return {
    ...result,
    search,
    page,
    onSearch(value: string) {
      setSearch(value);
      setPage(0);
      setTokens([""]);
    },
    onPage(next: number) {
      if (next < 0 || result.isPlaceholderData || search !== query) return;
      if (next > page) {
        if (!result.data?.nextPageToken) return;
        setTokens((current) => [...current.slice(0, page + 1), result.data?.nextPageToken ?? ""]);
      }
      setPage(next);
    },
  };
}

export function Failure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{t(errorKey(error, "management.unavailable"))}</AlertDescription>
    </Alert>
  ) : null;
}

export function ResourcePage({
  title,
  query,
  total,
  pending,
  fetching,
  error,
  onQuery,
  onRefresh,
  onAdd,
  page,
  onPage,
  toolbar,
  children,
  pagination = true,
  addDisabled = false,
}: {
  title: string;
  query: string;
  total: number;
  pending: boolean;
  fetching: boolean;
  error: unknown;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onAdd?: () => void;
  page: number;
  onPage: (page: number) => void;
  toolbar?: ReactNode;
  children: ReactNode;
  pagination?: boolean;
  addDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label={title}>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          {title}
          {!pending && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{total}</span>
          )}
        </h1>
        {onAdd && (
          <Button onClick={onAdd} disabled={addDisabled}>
            <Plus />
            {t("management.add")}
          </Button>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1 sm:max-w-sm">
          <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-label={t("management.search")}
            placeholder={t("management.search")}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={fetching}
          aria-label={t("configuration.refresh")}
        >
          <RefreshCw className={fetching ? "animate-spin" : undefined} />
        </Button>
        {toolbar}
      </div>
      <Failure error={error} />
      <div
        aria-busy={fetching}
        className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card [&_[data-slot=table-container]]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card"
      >
        {pending ? (
          <div
            className="flex justify-center py-20"
            role="status"
            aria-label={t("management.loading")}
          >
            <LoaderCircle className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          children
        )}
        {!fetching && !pending && !total && !error && (
          <p className="py-20 text-center text-sm text-muted-foreground">
            {t(query.trim() ? "management.noResults" : "management.empty")}
          </p>
        )}
      </div>
      {pagination && total > pageSize && (
        <PageControl
          page={page}
          pages={Math.ceil(total / pageSize)}
          onPage={onPage}
          disabled={fetching}
          label={t("pagination.label", { title })}
        />
      )}
    </section>
  );
}
