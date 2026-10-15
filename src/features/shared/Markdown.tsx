import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

export function Markdown({ children }: { children: string }) {
  return (
    <div className="agent-markdown" data-testid="task-answer">
      <ReactMarkdown remarkPlugins={plugins} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
