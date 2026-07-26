import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("privacy scan", () => {
  test("scans the shipped plugin runtime dist tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-privacy-scan-"));
    tempRoots.push(root);
    const runtimeDist = path.join(
      root,
      "plugins",
      "agent-workflow-bench",
      "runtime",
      "dist"
    );
    await mkdir(runtimeDist, { recursive: true });
    const blockedToken = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    await writeFile(
      path.join(runtimeDist, "generated.js"),
      `const credential = "${blockedToken}";\n`
    );

    const result = await execa(
      process.execPath,
      ["scripts/privacy-scan.mjs", "--root", root],
      {
        cwd: process.cwd(),
        reject: false
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("openai_api_token");
    expect(result.stderr).toContain(
      "plugins/agent-workflow-bench/runtime/dist/generated.js:1"
    );
    expect(result.stderr).not.toContain(blockedToken);
  });
});
