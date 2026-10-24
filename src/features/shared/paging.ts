import { useDeferredValue, useState } from "react";
export const pageSize = 12;

export interface HistoryPage {
  page: number;
  search: string;
  onPage: (page: number) => void;
  onSearch: (search: string) => void;
}

/** Keeps cursors for visited pages while only querying the selected page. */
export function usePaging(
  scope = "",
  searchControl?: { value: string; onChange: (value: string) => void },
) {
  const [input, setInput] = useState("");
  const search = searchControl?.value ?? input;
  const query = useDeferredValue(search);
  const pageScope = JSON.stringify([scope, query]);
  const [cursor, setCursor] = useState({ scope: pageScope, page: 0, tokens: [""] });
  const { page, tokens } = cursor.scope === pageScope ? cursor : { page: 0, tokens: [""] };
  return {
    pageSize,
    pageToken: tokens[page] ?? "",
    query,
    controls(nextPageToken = ""): HistoryPage {
      return {
        page,
        search,
        onPage(next) {
          let nextTokens = tokens;
          if (next > page) {
            if (!nextPageToken) return;
            nextTokens = [...tokens.slice(0, next), nextPageToken];
          }
          setCursor({ scope: pageScope, page: next, tokens: nextTokens });
        },
        onSearch(value) {
          if (searchControl) searchControl.onChange(value);
          else setInput(value);
          setCursor({ scope: pageScope, page: 0, tokens: [""] });
        },
      };
    },
  };
}
