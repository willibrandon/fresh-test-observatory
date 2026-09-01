import { normalizePath, pathKey } from "./path.ts";

/**
 * A `.gitignore` matcher with git's rules: last match wins, deeper files
 * override their parents, `!` re-includes, a trailing `/` matches directories
 * only, a pattern with a slash is anchored to its `.gitignore` directory, and a
 * file under an ignored directory stays ignored whatever later rules say.
 * Fresh's file explorer applies the same rules; the plugin-facing search does
 * not, so discovery filters its results through this.
 */
export interface IgnoreRule {
  base: string;
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

export function parseGitignore(directory: string, text: string): IgnoreRule[] {
  const base = pathKey(directory).replace(/\/$/, "");
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    let directoryOnly = false;
    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    const anchored = line.startsWith("/") || line.includes("/");
    if (line.startsWith("/")) line = line.replace(/^\/+/, "");
    if (!line) continue;
    const body = globToRegexSource(line);
    rules.push({
      base,
      negated,
      directoryOnly,
      regex: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`),
    });
  }
  return rules;
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const next = glob[index + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else if (next === undefined) {
          out += ".*";
          index += 1;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (character === "?") {
      out += "[^/]";
    } else if (character === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close < 0) {
        out += "\\[";
      } else {
        let inner = glob.slice(index + 1, close);
        if (inner.startsWith("!")) inner = `^${inner.slice(1)}`;
        out += `[${inner.replace(/\\/g, "\\\\")}]`;
        index = close;
      }
    } else if (character === "\\" && index + 1 < glob.length) {
      out += glob[index + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      index += 1;
    } else {
      out += character.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

export class GitignoreMatcher {
  private readonly rules: IgnoreRule[];
  private readonly root: string;
  private readonly decisions = new Map<string, boolean>();

  /** Rules must be ordered from the shallowest `.gitignore` to the deepest. */
  constructor(root: string, rules: readonly IgnoreRule[]) {
    this.root = pathKey(root).replace(/\/$/, "");
    this.rules = mergeRules(rules);
  }

  /**
   * Adds the rules of a nested `.gitignore` found while walking. They only
   * affect paths below their directory, none of which has been decided yet.
   */
  addRules(rules: readonly IgnoreRule[]): void {
    this.rules.push(...mergeRules(rules));
  }

  /** Whether a path, or any directory above it inside the root, is ignored. */
  isIgnored(path: string, isDirectory = false): boolean {
    const key = pathKey(path);
    if (!key.startsWith(`${this.root}/`)) return false;
    const segments = key.slice(this.root.length + 1).split("/");
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = `${current}/${segments[index]}`;
      const directory = index < segments.length - 1 || isDirectory;
      if (this.decide(current, directory)) return true;
    }
    return false;
  }

  private decide(path: string, directory: boolean): boolean {
    const cacheKey = `${directory ? "d" : "f"}:${path}`;
    const cached = this.decisions.get(cacheKey);
    if (cached !== undefined) return cached;
    let ignored = false;
    for (const rule of this.rules) {
      if (path !== rule.base && !path.startsWith(`${rule.base}/`)) continue;
      if (rule.directoryOnly && !directory) continue;
      const relative = path.slice(rule.base.length + 1);
      if (rule.regex.test(relative)) ignored = !rule.negated;
    }
    this.decisions.set(cacheKey, ignored);
    return ignored;
  }
}

/**
 * Consecutive rules with the same directory, kind, and sign give the same
 * answer whichever of them matches, so they collapse into one alternation.
 * A 300-line ignore file then costs a handful of regex tests per path.
 */
function mergeRules(rules: readonly IgnoreRule[]): IgnoreRule[] {
  const merged: Array<IgnoreRule & { sources: string[] }> = [];
  for (const rule of rules) {
    const last = merged.at(-1);
    if (
      last &&
      last.base === rule.base &&
      last.negated === rule.negated &&
      last.directoryOnly === rule.directoryOnly
    ) {
      last.sources.push(rule.regex.source);
      last.regex = new RegExp(last.sources.map((source) => `(?:${source})`).join("|"));
    } else {
      merged.push({ ...rule, sources: [rule.regex.source] });
    }
  }
  return merged.map(({ sources: _sources, ...rule }) => rule);
}

/**
 * Builds a matcher from the `.gitignore` files that could affect `paths`: the
 * root's and every one found in a directory above a candidate path.
 */
export function buildGitignoreMatcher(
  root: string,
  paths: readonly string[],
  readFile: (path: string) => string | null,
): GitignoreMatcher {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const directories = new Set<string>([normalizedRoot]);
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!pathKey(normalized).startsWith(`${pathKey(normalizedRoot)}/`)) continue;
    const segments = normalized.slice(normalizedRoot.length + 1).split("/");
    let current = normalizedRoot;
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = `${current}/${segments[index]}`;
      directories.add(current);
    }
  }
  const rules: IgnoreRule[] = [];
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    const text = readFile(`${directory}/.gitignore`);
    if (text) rules.push(...parseGitignore(directory, text));
  }
  return new GitignoreMatcher(normalizedRoot, rules);
}
