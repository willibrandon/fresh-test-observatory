import type { CoverageFile } from "./contracts.ts";
import { mergeCoverage } from "./model.ts";
import { resolvePath } from "./path.ts";
import { attributes, textContent } from "./xml.ts";

export function parseCobertura(xml: string, workspaceRoot = ""): CoverageFile[] {
  const source = textContent(xml.match(/<source>([\s\S]*?)<\/source>/i)?.[1]);
  const base = source || workspaceRoot;
  const files: CoverageFile[] = [];
  const classExpression = /<class\b([^>]*)>([\s\S]*?)<\/class>/gi;
  for (const classMatch of xml.matchAll(classExpression)) {
    const classAttrs = attributes(classMatch[1] ?? "");
    const filename = classAttrs.filename;
    if (!filename) continue;
    const lines = [];
    const lineExpression = /<line\b([^>]*?)(?:\/>|>[\s\S]*?<\/line>)/gi;
    for (const lineMatch of (classMatch[2] ?? "").matchAll(lineExpression)) {
      const attrs = attributes(lineMatch[1] ?? "");
      const line = Number(attrs.number);
      const hits = Number(attrs.hits);
      if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits)) continue;
      const conditionCoverage = attrs["condition-coverage"]?.match(/([\d.]+)%/);
      const branchRate = conditionCoverage ? Number(conditionCoverage[1]) / 100 : undefined;
      lines.push({ line, hits, ...(branchRate !== undefined ? { branchRate } : {}) });
    }
    files.push({ path: resolvePath(base, filename), lines });
  }
  return mergeCoverage(files);
}
