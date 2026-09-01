import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const generated = join(configRoot, "fresh", "types", "fresh.d.ts");
const checkedIn = resolve("types", "fresh.d.ts");
const metadata = JSON.parse(await readFile(resolve("package.json"), "utf8"));

async function canonicalTypes() {
  try {
    return await readFile(generated, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const version = metadata.fresh.min_version;
  const url = `https://raw.githubusercontent.com/sinelaw/fresh/v${version}/crates/fresh-editor/plugins/lib/fresh.d.ts`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download Fresh ${version} declarations: ${response.status}`);
  }
  return await response.text();
}

if (process.argv.includes("--check")) {
  const [actual, expected] = await Promise.all([readFile(checkedIn, "utf8"), canonicalTypes()]);
  if (actual !== expected) {
    throw new Error("types/fresh.d.ts is stale; run npm run sync-types");
  }
} else {
  await writeFile(checkedIn, await canonicalTypes());
}
