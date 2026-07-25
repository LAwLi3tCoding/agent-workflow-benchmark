import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertRegisteredTargetReview } from "./targetReview.js";
const repoRoot = findBenchmarkRoot();
export function getBenchmarkRoot() {
    return repoRoot;
}
export async function loadTargetPack(targetId, options = {}) {
    const registryPath = path.join(repoRoot, "configs/targets/registry.yaml");
    const registry = YAML.parse(await readFile(registryPath, "utf8"));
    const entry = registry.targets.find((target) => target.id === targetId);
    if (!entry) {
        throw new Error(`Target not found in registry: ${targetId}`);
    }
    const configPath = path.resolve(repoRoot, entry.configPath);
    const raw = YAML.parse(await readFile(configPath, "utf8"));
    const root = options.rootOverride
        ? path.resolve(options.rootOverride)
        : path.isAbsolute(raw.root)
            ? raw.root
            : path.resolve(repoRoot, raw.root);
    const target = { ...raw, root, configPath };
    await assertRegisteredTargetReview(target, repoRoot);
    return target;
}
export async function listTargetIds() {
    const registryPath = path.join(repoRoot, "configs/targets/registry.yaml");
    const registry = YAML.parse(await readFile(registryPath, "utf8"));
    return registry.targets.map((target) => target.id);
}
function findBenchmarkRoot() {
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
