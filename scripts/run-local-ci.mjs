#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pluginRoot = path.join(
  repoRoot,
  "plugins",
  "agent-workflow-bench"
);
const pluginWrapper = path.join(pluginRoot, "bin", "awb");

const checks = [
  ["runtime-preflight", assertRuntimePreflight],
  ["diff-hygiene", () => run("git", ["diff", "--check"])],
  ["typecheck", () => run(npm, ["run", "typecheck"])],
  ["full-tests", () => run(npm, ["test"])],
  ["plugin-build", () => run(npm, ["run", "plugin:build"])],
  ["runtime-parity", assertRuntimeParity],
  [
    "source-schema",
    () =>
      run(process.execPath, [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "validate-schema"
      ])
  ],
  ["packaged-schema", () => run(pluginWrapper, ["validate-schema"])],
  ["canonical-naming", assertCanonicalNaming],
  [
    "privacy-scan",
    () => run(process.execPath, ["scripts/privacy-scan.mjs"])
  ],
  ["fresh-install-smoke", runFreshInstallSmoke]
];

if (process.argv.length === 3 && process.argv[2] === "--list") {
  process.stdout.write(
    `${JSON.stringify(checks.map(([id]) => id))}\n`
  );
} else if (process.argv.length > 2) {
  throw new Error("Usage: node scripts/run-local-ci.mjs [--list]");
} else {
  for (const [id, check] of checks) {
    process.stdout.write(`\n==> ${id}\n`);
    await check();
  }
  process.stdout.write("\nLocal CI gate passed.\n");
}

async function assertRuntimeParity() {
  const result = await run(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      "plugins/agent-workflow-bench/runtime"
    ],
    { capture: true }
  );
  if (result.stdout.trim()) {
    process.stderr.write(
      "Generated plugin runtime is out of date. Run npm run plugin:build and commit the runtime diff.\n"
    );
    process.stderr.write(`${result.stdout.trim()}\n`);
    process.exitCode = 1;
    throw new Error("plugin runtime parity failed");
  }
}

async function assertRuntimePreflight() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(
      `Node.js 22 or newer is required; current runtime is ${process.versions.node}.`
    );
  }
  process.stdout.write(
    `Node.js ${process.versions.node} accepted; hosted CI is pinned to Node.js 22.\n`
  );
}

async function assertCanonicalNaming() {
  const legacySlug = ["agent", "workflow", "benchmark"].join("-");
  const legacyTitle = ["Agent Workflow", "Benchmark"].join(" ");
  const result = await run("git", ["ls-files", "-z"], { capture: true });
  const offenders = [];
  for (const relativePath of result.stdout.split("\0").filter(Boolean)) {
    if (
      relativePath.includes(legacySlug) ||
      relativePath.includes(legacyTitle)
    ) {
      offenders.push(relativePath);
      continue;
    }
    const bytes = await readFile(path.join(repoRoot, relativePath));
    if (bytes.includes(0)) {
      continue;
    }
    const content = bytes.toString("utf8");
    if (
      content.includes(legacySlug) ||
      content.includes(legacyTitle)
    ) {
      offenders.push(relativePath);
    }
  }
  if (offenders.length > 0) {
    process.stderr.write(
      "Legacy Agent Workflow Bench naming found in these repository-relative files:\n"
    );
    process.stderr.write(`${offenders.sort().join("\n")}\n`);
    throw new Error("canonical naming scan failed");
  }
}

async function runFreshInstallSmoke() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "awb-local-ci-install-")
  );
  const copiedPlugin = path.join(
    tempRoot,
    "plugin",
    "agent-workflow-bench"
  );
  try {
    await cp(pluginRoot, copiedPlugin, { recursive: true });
    await rm(path.join(copiedPlugin, "runtime", "node_modules"), {
      recursive: true,
      force: true
    });
    await run(
      path.join(copiedPlugin, "bin", "awb"),
      ["validate-schema"],
      { cwd: tempRoot }
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true;
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      if (capture && stderr) {
        process.stderr.write(stderr);
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`
          }`
        )
      );
    });
  });
}
