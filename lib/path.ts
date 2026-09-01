export function normalizePath(path: string): string {
  let value = path.replace(/\\/g, "/");
  const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  const prefix = /^[A-Za-z]:\//.test(value) ? value.slice(0, 2) : "";
  const body = prefix ? value.slice(2) : value;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop();
    } else if (part !== ".." || !absolute) {
      parts.push(part);
    }
  }
  const root = prefix ? `${prefix}/` : absolute ? "/" : "";
  return root + parts.join("/");
}

/** Comparison-only key; host-facing paths retain their original drive spelling. */
export function pathKey(path: string): string {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function stem(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = pathKey(root).replace(/\/$/, "");
  const normalizedCandidate = pathKey(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export function relativePath(root: string, candidate: string): string {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const normalizedCandidate = normalizePath(candidate);
  const rootKey = pathKey(normalizedRoot);
  return isWithin(normalizedRoot, normalizedCandidate)
    ? normalizedCandidate.slice(rootKey.length).replace(/^\//, "")
    : normalizedCandidate;
}

export function resolvePath(root: string, path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) return normalizePath(path);
  return joinPath(root, path);
}

export function safeName(path: string): string {
  return stem(path).replace(/[^A-Za-z0-9_.-]+/g, "-") || "tests";
}
