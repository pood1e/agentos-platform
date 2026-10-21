import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { knowledgeReference, knowledgeSections, knowledgeSegments } from "./knowledge-content.js";

const tasks = /(?:Task|任务)\s*[：:]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/gi;

function EvidenceText({ text }: { text: string }) {
  const { t } = useTranslation();
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(tasks)) {
    parts.push(text.slice(offset, match.index));
    parts.push(
      <Link
        key={match.index}
        to={`/chat?${new URLSearchParams({ task: match[1] })}`}
        title={match[1]}
      >
        {t("management.viewEvidenceTask")}
      </Link>,
    );
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return parts;
}

function KnowledgeEvidence({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Collapsible.Root className="rounded-lg border bg-muted/25 px-4 py-3">
      <Collapsible.Trigger asChild>
        <Button
          variant="ghost"
          className="group h-auto w-full justify-between p-0 text-xs text-muted-foreground"
        >
          {t("management.knowledgeEvidence")}
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content className="space-y-3 pt-3 text-xs leading-6 text-muted-foreground">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function KnowledgeParagraph({ children }: ComponentProps<"p">) {
  if (typeof children !== "string") return <p>{children}</p>;
  const sentences = knowledgeSegments(children);
  const body = sentences.filter(({ text }) => !knowledgeReference(text));
  const evidence = sentences.filter(({ text }) => knowledgeReference(text));
  return (
    <div className="space-y-4">
      {body.map(({ text, offset }) => (
        <p key={offset}>{text}</p>
      ))}
      {evidence.length > 0 && (
        <KnowledgeEvidence>
          {evidence.map(({ text, offset }) => (
            <p key={offset}>
              <EvidenceText text={text} />
            </p>
          ))}
        </KnowledgeEvidence>
      )}
    </div>
  );
}

const components = { p: KnowledgeParagraph };
const plugins = [remarkGfm];

export function KnowledgeArticle({ content }: { content: string }) {
  const { body, evidence } = knowledgeSections(content);
  return (
    <article
      className="agent-markdown text-[15px] leading-7 text-foreground [&_h2]:text-base [&_h3]:text-sm [&_code]:text-xs"
      data-testid="knowledge-article"
    >
      <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
        {body}
      </ReactMarkdown>
      {evidence && (
        <KnowledgeEvidence>
          <ReactMarkdown remarkPlugins={plugins} skipHtml>
            {evidence}
          </ReactMarkdown>
        </KnowledgeEvidence>
      )}
    </article>
  );
}
