import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import { AccessProfileSchema } from "../gen/agentos/console/v1/access_pb.js";
import {
  lastConversation,
  rememberConversation,
} from "../src/features/chat/conversation-storage.js";

afterEach(() => vi.unstubAllGlobals());

it("does not restore a conversation from a recreated workspace", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const profile = (uid: string) =>
    create(AccessProfileSchema, {
      subject: "oidc:alice",
      workspace: { namespace: "team", uid },
    });
  rememberConversation(profile("old-uid"), "73383ee6-c3b3-4f2a-a926-920d936e3a7a");
  expect(lastConversation(profile("old-uid"))).toContain("/chat/");
  expect(lastConversation(profile("new-uid"))).toBe("");
});
