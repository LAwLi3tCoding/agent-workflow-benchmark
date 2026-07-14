import { describe, expect, test } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();

const scannedRoots = [
  "src",
  "schemas",
  "configs",
  "fixtures",
  "tests",
  "plugins/agent-workflow-benchmark/runtime/configs",
  "plugins/agent-workflow-benchmark/skills",
  "README.md",
  "docs/agent-workflow-benchmark-human-guide.md",
  "docs/ai-workflow-evaluation-methodology.md",
  "docs/agent-workflow-benchmark-plugin-guide.md"
];

const prohibitedTargetTerms = [
  ["saas", "platform", String.fromCharCode(118, 56)].join("-"),
  ["@", "saas", "-", "platform", String.fromCharCode(86, 56)].join(""),
  ["scrum", "master", "agent"].join("-"),
  ["platform", "be", "only", "agent"].join("-"),
  ["platform", "fe", "only", "agent"].join("-"),
  ["test", "designer", "agent"].join("-"),
  ["qa", "agent"].join("-"),
  ["prd", "reviewer", "agent"].join("-"),
  ["design", "reviewer", "agent"].join("-"),
  ["code", "reviewer", "agent"].join("-")
];

async function listFiles(root: string): Promise<string[]> {
  const absolute = path.join(cwd, root);
  const info = await stat(absolute);
  if (info.isFile()) {
    return [absolute];
  }

  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(child) : Promise.resolve([path.join(cwd, child)]);
    })
  );
  return nested.flat();
}

describe("tool source boundary", () => {
  test("does not publish target-agent-specific contracts in reusable tool assets", async () => {
    const files = (await Promise.all(scannedRoots.map(listFiles))).flat();
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const term of prohibitedTargetTerms) {
        if (content.includes(term)) {
          offenders.push(`${path.relative(cwd, file)} contains ${term}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
