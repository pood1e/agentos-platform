const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const titleLength = 32;

/** First clause of an instruction, limited to 32 graphemes. */
export function shortTitle(prompt: string): string {
  const clause = prompt.trim().split(/[\r\n，。！？；：]|[,.!?;:](?:\s|$)/u, 1)[0] ?? "";
  const segments = [...graphemes.segment(clause.replace(/\s+/gu, " ").trim())].map(
    (item) => item.segment,
  );
  return segments.length > titleLength
    ? `${segments.slice(0, titleLength - 1).join("")}…`
    : segments.join("");
}
