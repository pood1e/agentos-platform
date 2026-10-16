import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskContent } from "../src/features/tasks/TaskContent.js";
import "../src/i18n/index.js";

const render = (content: string) => renderToStaticMarkup(createElement(TaskContent, { content }));

describe("task instructions", () => {
  it("renders short delegation lists, references and commands with their native structure", () => {
    const html = render(
      "- 目标：登记两台设备\n- 上下文：[原任务](/tasks/original)\n- 交付：资源链接\n- 边界：使用现有采集\n\n```sh\nuname -a\n```",
    );
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain('href="/tasks/original"');
    expect(html).toContain('<pre><code class="language-sh">uname -a\n</code></pre>');
  });

  it("breaks old long prose at sentence boundaries without dropping or rewriting facts", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, index) => `第${index + 1}条已确认事实保留原始来源和具体资源引用。`,
    );
    const html = render(sentences.join(""));
    expect(html.match(/<p>/g)).toHaveLength(6);
    const paragraphs = Array.from(html.matchAll(/<p>(.*?)<\/p>/g), (match) => match[1]);
    expect(paragraphs.join("")).toBe(sentences.join(""));
  });

  it("keeps formatted prose and code literal and omits raw HTML", () => {
    const html = render(
      "**结果**：保留 `contextId`。\n\n```text\n<script>literal</script>\n```\n\n<script>alert(1)</script>",
    );
    expect(html).toContain("<strong>结果</strong>");
    expect(html).toContain("<code>contextId</code>");
    expect(html).toContain("&lt;script&gt;literal&lt;/script&gt;");
    expect(html).not.toContain("alert(1)");
  });

  it("separates soft line breaks in native delegation text", () => {
    const html = render("NCCL缺项补核\n上下文：读取已有附件。\n交付：确认实际依赖。\n边界：只读。");
    expect(html.match(/<p>/g)).toHaveLength(4);
    expect(html).toContain("<p>交付：确认实际依赖。</p>");
  });

  it("preserves inline links and code when separating delegation lines", () => {
    const html = render(
      "NCCL缺项补核\n上下文：[原任务](/tasks/original)。\n交付：确认 `MPI` 依赖。\n边界：只读。",
    );
    expect(html.match(/<p>/g)).toHaveLength(4);
    expect(html).toContain('href="/tasks/original"');
    expect(html).toContain("<code>MPI</code>");
  });
});
