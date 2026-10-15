import { useDeferredValue, useState } from "react";
import { type HistoryPage, pageSize } from "./HistoryList.js";

/** Keeps cursors for visited pages while only querying the selected page. */
export function usePaging() {
  const [page, setPage] = useState(0);
  const [tokens, setTokens] = useState([""]);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  return {
    pageSize,
    pageToken: tokens[page] ?? "",
    query,
    controls(nextPageToken = ""): HistoryPage {
      return {
        page,
        search,
        onPage(next) {
          if (next > page) {
            if (!nextPageToken) return;
            setTokens((previous) => [...previous.slice(0, next), nextPageToken]);
          }
          setPage(next);
        },
        onSearch(value) {
          setSearch(value);
          setPage(0);
          setTokens([""]);
        },
      };
    },
  };
}
