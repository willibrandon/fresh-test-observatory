import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const generated = join(configRoot, "fresh", "types", "fresh.d.ts");
const checkedIn = resolve("types", "fresh.d.ts");

if (process.argv.includes("--check")) {
  const [actual, expected] = await Promise.all([
    readFile(checkedIn, "utf8"),
    readFile(generated, "utf8"),
  ]);
  if (actual !== expected) {
    throw new Error("types/fresh.d.ts is stale; run npm run sync-types");
  }
} else {
  await copyFile(generated, checkedIn);
}
