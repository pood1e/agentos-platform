import { expect, it } from "vitest";
import { shortTitle } from "../server/read-model/views/title.js";

it("uses a short opening clause in either language without splitting URLs", () => {
  expect(shortTitle("检查支付服务延迟，定位根因并给出处置建议")).toBe("检查支付服务延迟");
  expect(shortTitle("Inspect payment latency: collect logs and metrics")).toBe(
    "Inspect payment latency",
  );
  expect(shortTitle("检查 https://example.com/v1 状态\n完整指令")).toBe(
    "检查 https://example.com/v1 状态",
  );
  expect(shortTitle("   Check\tservice status   ")).toBe("Check service status");
});

it("limits long titles to 32 graphemes", () => {
  const emoji = "👩🏽‍💻";
  expect(shortTitle(emoji.repeat(40))).toBe(`${emoji.repeat(31)}…`);
});
