import { ChevronDown, ChevronUp } from "lucide-react";
import { Children, type ComponentProps, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const plugins = [remarkGfm];

function Paragraph({ children }: ComponentProps<"p">) {
  const paragraphs: { end: number; nodes: ReactNode[] }[] = [];
  let nodes: ReactNode[] = [];
  let cursor = 0;
  const flush = () => {
    if (nodes.length) paragraphs.push({ end: cursor, nodes });
    nodes = [];
  };
  for (const child of Children.toArray(children)) {
    if (typeof child !== "string") {
      nodes.push(child);
      cursor++;
      continue;
    }
    for (const [index, line] of child.split(/\n+/u).entries()) {
      if (index) flush();
      const sentences = Array.from(segmenter.segment(line));
      for (const [index, sentence] of sentences.entries()) {
        if (line.length >= 240 && index > 0 && index % 2 === 0) flush();
        nodes.push(sentence.segment);
        cursor += sentence.segment.length;
      }
    }
  }
  flush();
  return paragraphs.map(({ end, nodes }) => <p key={end}>{nodes}</p>);
}

const components = { p: Paragraph };

export function TaskContent({ content }: { content: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = content.length > 600;
  const markdown = (text: string) => (
    <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
      {text}
    </ReactMarkdown>
  );
  return (
    <div
      className="agent-markdown space-y-3 text-sm leading-6 [overflow-wrap:anywhere] [&_li]:my-1.5 [&_p]:my-3 [&_pre]:max-h-72 [&_pre]:overflow-auto"
      data-testid="task-prompt"
    >
      {long ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          {!open && markdown(`${Array.from(content).slice(0, 300).join("").trimEnd()}…`)}
          <CollapsibleContent>{markdown(content)}</CollapsibleContent>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-1 text-muted-foreground">
              {open ? <ChevronUp /> : <ChevronDown />}
              {t(open ? "task.collapseContent" : "task.expandContent")}
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
      ) : (
        markdown(content)
      )}
    </div>
  );
}
