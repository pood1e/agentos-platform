const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;

export const knowledgeSegments = (content: string) =>
  Array.from(segmenter.segment(content), (entry) => ({
    text: entry.segment.trim(),
    offset: entry.index,
  })).filter((entry) => entry.text);

export const knowledgeSentences = (content: string) =>
  knowledgeSegments(content).map((entry) => entry.text);

export const knowledgeReference = (text: string) =>
  /^(?:来源|Sources?)\s*[：:]/i.test(text) || uuid.test(text);

export function knowledgeSections(content: string) {
  const heading = /^#{1,6}\s+(?:来源|Sources?)\s*[:：]?\s*$/im.exec(content);
  return {
    body: heading ? content.slice(0, heading.index).trim() : content,
    evidence: heading ? content.slice(heading.index + heading[0].length).trim() : "",
  };
}

export function knowledgeDocument(content: string) {
  const value = content.trim();
  const heading = /^#{1,6}\s+([^\n]+)(?:\n|$)/.exec(value);
  const title = heading?.[1]?.trim() ?? knowledgeSentences(value)[0] ?? "";
  const body = value.slice(heading?.[0].length ?? title.length).trim();
  const excerpt = knowledgeSentences(knowledgeSections(body).body)
    .filter((text) => !knowledgeReference(text))
    .join(" ")
    .split("\n")
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join(" ")
    .replace(/`([^`]+)`/g, "$1");
  return { title, body, excerpt };
}
