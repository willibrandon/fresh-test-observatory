const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const hex = body[1]?.toLowerCase() === "x";
      const point = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    return XML_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

export function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
}

export function textContent(value: string | undefined): string {
  if (!value) return "";
  return decodeXml(stripMarkup(stripCdata(value))).trim();
}

function stripMarkup(value: string): string {
  let text = "";
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open < 0) return text + value.slice(cursor);
    text += value.slice(cursor, open);
    const close = value.indexOf(">", open + 1);
    if (close < 0) return text + value.slice(open);
    cursor = close + 1;
  }
  return text;
}

export function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(expression)) {
    result[match[1]!] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
