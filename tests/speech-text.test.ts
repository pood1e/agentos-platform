import { expect, it } from "vitest";
import { speechText } from "../shared/speech-text.js";

it.each([
  [
    "# 检查结果\n\n**系统健康。**\n\n[报告](https://example.test/report)",
    "检查结果\n\n系统健康。\n\n报告",
  ],
  ["检查 `nginx`，保留原配置。", "检查 nginx，保留原配置。"],
  ["**All services are healthy.**", "All services are healthy."],
  ["**جميع الخدمات تعمل بشكل طبيعي.**", "جميع الخدمات تعمل بشكل طبيعي."],
  ['```json\n{"tool":"k8s_get_resources","result":"raw"}\n```', ""],
  [
    "| 设备数 | 使用率 |\n|---|---|\n| 12 | 85.5% |\n\n结果正常。",
    "设备数, 使用率\n12, 85.5%\n\n结果正常。",
  ],
  [
    "IP 是 `172.16.140.15`，端口 **443**，编号 GPU-08。",
    "IP 是 172.16.140.15，端口 443，编号 GPU-08。",
  ],
  ["12 devices, 85.5% CPU usage, port 8443.", "12 devices, 85.5% CPU usage, port 8443."],
  ["يوجد 12 جهازًا، والمنفذ 443.", "يوجد 12 جهازًا، والمنفذ 443."],
  ["![工具图标](https://example.test/icon.svg)\n\n<div>工具详情</div>\n\n完成。", "完成。"],
])("extracts speakable prose from %s", (markdown, expected) => {
  expect(speechText(markdown)).toBe(expected);
});
