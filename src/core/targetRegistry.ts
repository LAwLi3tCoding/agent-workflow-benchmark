import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { TargetPack } from "./types.js";

const repoRoot = findBenchmarkRoot();

export function getBenchmarkRoot(): string {
  return repoRoot;
}

export async function loadTargetPack(targetId: string): Promise<TargetPack> {
  const registryPath = path.join(repoRoot, "configs/targets/registry.yaml");
  const registry = YAML.parse(await readFile(registryPath, "utf8")) as {
    targets: Array<{ id: string; configPath: string }>;
  };
  const entry = registry.targets.find((target) => target.id === targetId);
  if (!entry) {
    throw new Error(`Target not found in registry: ${targetId}`);
  }
  const configPath = path.resolve(repoRoot, entry.configPath);
  const raw = YAML.parse(await readFile(configPath, "utf8")) as Omit<TargetPack, "configPath">;
  const root = path.isAbsolute(raw.root) ? raw.root : path.resolve(repoRoot, raw.root);
  return { ...raw, root, configPath };
}

export async function listTargetIds(): Promise<string[]> {
  const registryPath = path.join(repoRoot, "configs/targets/registry.yaml");
  const registry = YAML.parse(await readFile(registryPath, "utf8")) as {
    targets: Array<{ id: string; configPath: string }>;
  };
  return registry.targets.map((target) => target.id);
}

function findBenchmarkRoot(): string {
  if (process.env.AWB_PROJECT_ROOT) {
    return path.resolve(process.env.AWB_PROJECT_ROOT);
  }

  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(current, "configs/targets/registry.yaml")) && existsSync(path.join(current, "schemas"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}
