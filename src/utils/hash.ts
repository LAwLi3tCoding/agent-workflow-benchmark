import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function hashFile(filePath: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
}

export async function hashPath(inputPath: string): Promise<string> {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return hashFile(inputPath);
  }
  const files = await listFiles(inputPath);
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = path.relative(inputPath, file);
    hash.update(rel);
    hash.update(await readFile(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === "node_modules") {
        continue;
      }
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(next);
      } else if (entry.isFile()) {
        output.push(next);
      }
    }
  }
  await visit(root);
  return output.sort();
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
