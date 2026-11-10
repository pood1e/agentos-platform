import { expect, it } from "vitest";
import { movedCursor, type PageCursor } from "../src/features/shared/paging.js";

const cursor: PageCursor = { scope: "skills", page: 1, tokens: ["", "second"] };

it("stores the next token when moving forward", () => {
  expect(movedCursor(cursor, 2, "third")).toEqual({
    scope: "skills",
    page: 2,
    tokens: ["", "second", "third"],
  });
});

it("cannot move past a page without a next token or before the first page", () => {
  expect(movedCursor(cursor, 2, "")).toBeUndefined();
  expect(movedCursor(cursor, -1, "third")).toBeUndefined();
});

it("reuses visited tokens when moving back and forgets later ones when moving on", () => {
  const back = movedCursor(cursor, 0, "ignored");
  expect(back).toEqual({ scope: "skills", page: 0, tokens: ["", "second"] });
  if (!back) throw new Error("Expected a move back");
  expect(movedCursor(back, 1, "replacement")?.tokens).toEqual(["", "replacement"]);
});
