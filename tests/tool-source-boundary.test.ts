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
  "plugins/agent-workflow-bench/runtime/configs",
  "plugins/agent-workflow-bench/skills",
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "docs/agent-workflow-bench-human-guide.md",
  "docs/ai-workflow-evaluation-methodology.md",
  "docs/agent-workflow-bench-plugin-guide.md"
];

const sourceFacingPrivacyRoots = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "docs",
  "configs",
  "fixtures",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  "plugins/agent-workflow-bench/.codex-plugin",
  "plugins/agent-workflow-bench/.claude-plugin",
  "plugins/agent-workflow-bench/skills",
  "plugins/agent-workflow-bench/commands"
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

const prohibitedSourcePrivacyPatterns = [
  { label: "absolute user home path", pattern: new RegExp(["/", "Users", "/"].join(""), "u") },
  { label: "personal GitHub handle", pattern: new RegExp(`\\b${["LAw", "Li3t", "Coding"].join("")}\\b`, "u") },
  { label: "local user id", pattern: new RegExp(`\\b${["liu", "yi", "85"].join("")}\\b`, "u") },
  { label: "company domain token", pattern: new RegExp(`\\b${["san", "kuai"].join("")}\\b`, "iu") },
  {
    label: "company name token",
    pattern: new RegExp(`\\b${["mei", "tuan"].join("")}\\b|${["美", "团"].join("")}`, "u")
  },
  {
    label: "internal business-data marker",
    pattern: new RegExp(
      [
        ["内", "部", "业", "务", "数", "据"].join(""),
        ["internal", "business", "data"].join(" ")
      ].join("|"),
      "iu"
    )
  }
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

  test("does not publish personal or company identifiers in source-facing package assets", async () => {
    const files = (await Promise.all(sourceFacingPrivacyRoots.map(listFiles))).flat();
    const offenders: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const { label, pattern } of prohibitedSourcePrivacyPatterns) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(cwd, file)} contains ${label}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
