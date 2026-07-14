import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}
export async function writeJson(filePath, value) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
export async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
}
export async function writeYaml(filePath, value) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, YAML.stringify(value));
}
export async function readYaml(filePath) {
    return YAML.parse(await readFile(filePath, "utf8"));
}
