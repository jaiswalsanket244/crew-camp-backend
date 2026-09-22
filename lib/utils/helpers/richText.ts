// Rich text is stored as ProseMirror (TipTap) JSON — a tree whose `text`
// leaves carry the characters. Mongo cannot regex inside that, so documents
// keep a flattened copy of their body for searching.
const SEARCH_TEXT_MAX_CHARS = 5000;

export const richTextToPlain = (
  doc: unknown,
  maxChars: number = SEARCH_TEXT_MAX_CHARS,
): string => {
  if (!doc || typeof doc !== "object") return "";
  const parts: string[] = [];
  let length = 0;

  const walk = (node: unknown): void => {
    if (length > maxChars) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const entry = node as { text?: unknown; content?: unknown };
    if (typeof entry.text === "string") {
      parts.push(entry.text);
      length += entry.text.length + 1;
    }
    if (entry.content) walk(entry.content);
  };

  walk((doc as { content?: unknown }).content);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxChars);
};

// Several docs (a daily log's overview plus its notes) flatten into one field.
export const richTextsToPlain = (docs: unknown[]): string =>
  docs
    .map((doc) => richTextToPlain(doc))
    .filter(Boolean)
    .join(" ")
    .slice(0, SEARCH_TEXT_MAX_CHARS);
