import { expect, it, vi } from "vitest";
import { RemoteSpeechAdapter } from "../src/features/chat/speech/synthesis.js";
import { speechText } from "../src/features/chat/speech/text.js";

it.each([
  [
    "# 检查结果\n\n**系统健康。**\n\n[报告](https://example.test/report)",
    "检查结果\n\n系统健康。\n\n报告",
  ],
  ["检查 `nginx`，保留原配置。", "检查 nginx，保留原配置。"],
  ["**All services are healthy.**", "All services are healthy."],
  ["**جميع الخدمات تعمل بشكل طبيعي.**", "جميع الخدمات تعمل بشكل طبيعي."],
  ['```json\n{"tool":"k8s_get_resources","result":"raw"}\n```', ""],
  ["| Tool | Result |\n|---|---|\n| k8s_get_resources | raw |\n\n结果正常。", "结果正常。"],
  ["![工具图标](https://example.test/icon.svg)\n\n<div>工具详情</div>\n\n完成。", "完成。"],
])("extracts speakable prose from %s", (markdown, expected) => {
  expect(speechText(markdown)).toBe(expected);
});

it("skips synthesis when an answer only contains code", () => {
  const synthesizeSpeech =
    vi.fn<ConstructorParameters<typeof RemoteSpeechAdapter>[0]["synthesizeSpeech"]>();
  const report = vi.fn();
  const adapter = new RemoteSpeechAdapter({ synthesizeSpeech }, report);
  const utterance = adapter.speak('```json\n{"tool":"k8s_get_resources"}\n```');
  expect(utterance.status).toEqual({ type: "ended", reason: "finished" });
  expect(synthesizeSpeech).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});
