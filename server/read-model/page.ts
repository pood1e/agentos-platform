import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type PageCursor, PageCursorSchema } from "../../gen/agentos/console/v1/page_pb.js";
import { invalid } from "../shared/errors.js";

export interface PageRequest {
  pageSize: number;
  pageToken: string;
  query: string;
}

/** Position of an item in a collection ordered by time descending, then ID ascending. */
export interface PageKey {
  id: string;
  time: number;
}

function decode(token: string, scope: string, query: string): PageCursor {
  try {
    const cursor = fromBinary(PageCursorSchema, Buffer.from(token, "base64url"));
    if (cursor.scope === scope && cursor.query === query) return cursor;
  } catch {}
  throw invalid("pagination.invalidPage");
}

const encode = (cursor: PageCursor) =>
  Buffer.from(toBinary(PageCursorSchema, cursor)).toString("base64url");

/** Keyset pagination: items that move or disappear do not invalidate later pages. */
export function pageOf<T>(
  items: T[],
  request: PageRequest,
  scope: string,
  key: (item: T) => PageKey,
) {
  let start = 0;
  if (request.pageToken) {
    const cursor = decode(request.pageToken, scope, request.query);
    const time = Number(cursor.afterTime);
    start = items.findIndex((item) => {
      const position = key(item);
      return (
        position.time < time ||
        (position.time === time && position.id.localeCompare(cursor.afterId) > 0)
      );
    });
    if (start < 0) start = items.length;
  }
  const selected = items.slice(start, start + (request.pageSize || 12));
  const last = selected.at(-1);
  const position = last && start + selected.length < items.length ? key(last) : undefined;
  return {
    items: selected,
    totalSize: items.length,
    nextPageToken: position
      ? encode(
          create(PageCursorSchema, {
            scope,
            query: request.query,
            afterId: position.id,
            afterTime: BigInt(position.time),
          }),
        )
      : "",
  };
}
