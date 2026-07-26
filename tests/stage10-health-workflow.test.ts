import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeHealthGateEligibility,
  portableCommandValue,
  redactPublicCommandText
} from "../src/ci/benchmarkHealthWorkflow.js";

describe("Stage 10 benchmark-health workflow safety", () => {
  test("preserves reliability BLOCK so degraded health still reaches the aggregator", () => {
    expect(normalizeHealthGateEligibility("BLOCK")).toBe("BLOCK");
    expect(normalizeHealthGateEligibility("DIAGNOSTIC_ONLY")).toBe(
      "DIAGNOSTIC_ONLY"
    );
    expect(normalizeHealthGateEligibility("unexpected")).toBe("BLOCK");
  });

  test("redacts temporary and external absolute paths from public command evidence", () => {
    const repoRoot = path.resolve("/workspace/agent-workflow-bench");
    const tempRoot = path.resolve("/private/tmp/awb-health-secret");
    const externalRoot = path.join(
      path.sep,
      "Users",
      "example",
      "private",
      "output"
    );
    expect(
      portableCommandValue(path.join(repoRoot, "dist/cli.js"), {
        repoRoot,
        tempRoots: [tempRoot]
      })
    ).toBe("dist/cli.js");
    expect(
      portableCommandValue(path.join(tempRoot, "private-key.pem"), {
        repoRoot,
        tempRoots: [tempRoot]
      })
    ).toBe("<ephemeral-temp-path>");
    expect(
      portableCommandValue(`${externalRoot}.json`, {
        repoRoot,
        tempRoots: [tempRoot]
      })
    ).toBe("<external-path>");

    const redacted = redactPublicCommandText(
      `cwd=${tempRoot}\nout=${externalRoot}\n`,
      {
        repoRoot,
        outputRoot: externalRoot,
        tempRoots: [tempRoot]
      }
    );
    expect(redacted).not.toContain(tempRoot);
    expect(redacted).not.toContain(
      path.join(path.sep, "Users", "example")
    );
    expect(redacted).toContain("<ephemeral-temp>");
    expect(redacted).toContain("<output>");
  });

  test("schedules qualification on the supported macOS isolation backend", async () => {
    const workflow = await readFile(
      path.join(process.cwd(), ".github/workflows/benchmark-health.yml"),
      "utf8"
    );
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).not.toContain("runs-on: ubuntu-latest");
  });
});
