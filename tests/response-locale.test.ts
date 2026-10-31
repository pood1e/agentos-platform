import { afterEach, expect, it, vi } from "vitest";

const language = vi.hoisted(() => ({ resolvedLanguage: "en", language: "en" }));
vi.mock("../src/i18n/index.js", () => ({ default: language }));

afterEach(() => vi.unstubAllGlobals());

it("sends the currently selected page language on each request without reloading", async () => {
  const received: string[] = [];
  vi.stubGlobal("window", { location: { origin: "http://console.example" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    received.push(request.headers.get("Accept-Language") ?? "");
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  });
  const { consoleClient } = await import("../src/lib/console.js");
  await consoleClient.getAccessProfile({});
  language.resolvedLanguage = "zh";
  await consoleClient.getAccessProfile({});
  expect(received).toEqual(["en", "zh"]);
});
