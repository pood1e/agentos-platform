import { useDeferredValue, useState } from "react";

export const pageSize = 12;

export interface HistoryPage {
  page: number;
  search: string;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
}

/** Tokens of the pages visited within one scope and query. */
export interface PageCursor {
  scope: string;
  page: number;
  tokens: string[];
}

const firstPage = (scope: string): PageCursor => ({ scope, page: 0, tokens: [""] });

/** Moving forward needs the current page's next token; earlier pages keep their own. */
export function movedCursor(
  cursor: PageCursor,
  next: number,
  nextPageToken: string,
): PageCursor | undefined {
  if (next < 0 || (next > cursor.page && !nextPageToken)) return undefined;
  return {
    ...cursor,
    page: next,
    tokens: next > cursor.page ? [...cursor.tokens.slice(0, next), nextPageToken] : cursor.tokens,
  };
}

/** Keeps cursors for visited pages while only querying the selected page. */
export function usePaging(scope = "") {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const pageScope = JSON.stringify([scope, query]);
  const [stored, setStored] = useState(() => firstPage(pageScope));
  const cursor = stored.scope === pageScope ? stored : firstPage(pageScope);
  return {
    pageSize,
    pageToken: cursor.tokens[cursor.page] ?? "",
    query,
    controls(nextPageToken = ""): HistoryPage {
      return {
        page: cursor.page,
        search,
        onPage(next) {
          const moved = movedCursor(cursor, next, nextPageToken);
          if (moved) setStored(moved);
        },
        onSearch(value) {
          setSearch(value);
          setStored(firstPage(pageScope));
        },
      };
    },
  };
}
