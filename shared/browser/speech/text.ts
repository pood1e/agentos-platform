import { toString as plainText } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import stripMarkdown from "strip-markdown";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(stripMarkdown, { remove: ["image", "imageReference"], keep: ["table", "tableCell"] });

export function speechText(markdown: string) {
  const root = processor.runSync(processor.parse(markdown));
  return root.children
    .map((node) =>
      node.type === "table"
        ? node.children
            .map((row) => row.children.map((cell) => plainText(cell)).join(", "))
            .join("\n")
        : plainText(node),
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
