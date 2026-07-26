import { readFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

const cwd = process.cwd();

describe("local CI parity", () => {
  test("exposes the ordered local gate used by GitHub CI", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8")
    ) as {
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const workflow = await readFile(
      path.join(cwd, ".github/workflows/ci.yml"),
      "utf8"
    );

    expect(packageJson.scripts?.["ci:local"]).toBe(
      "node scripts/run-local-ci.mjs"
    );
    expect(packageJson.engines?.node).toBe(">=22");
    expect(workflow).toContain("run: npm run ci:local");

    const result = await execa(
      process.execPath,
      ["scripts/run-local-ci.mjs", "--list"],
      { cwd }
    );

    expect(JSON.parse(result.stdout)).toEqual([
      "runtime-preflight",
      "diff-hygiene",
      "typecheck",
      "full-tests",
      "plugin-build",
      "runtime-parity",
      "source-schema",
      "packaged-schema",
      "canonical-naming",
      "privacy-scan",
      "fresh-install-smoke"
    ]);
  });
});
