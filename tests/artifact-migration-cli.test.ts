import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashFile } from "../src/utils/hash.js";

const cwd = process.cwd();
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "awb-stage7-cli-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Stage 7 artifact migration CLI", () => {
  test("exposes artifact migration help", async () => {
    const topLevel = await awb(["--help"]);
    const artifactHelp = await awb(["artifact", "--help"]);

    expect(topLevel.stdout).toContain("artifact");
    expect(artifactHelp.stdout).toContain("migrate");
  });

  test("writes a schema-valid migrated artifact and migration result", async () => {
    const input = path.join(root, "runtime-manifest.json");
    const out = path.join(root, "out");
    await writeFile(
      input,
      `${JSON.stringify(legacyRuntime(), null, 2)}\n`
    );

    const result = await awb([
      "artifact",
      "migrate",
      "--input",
      input,
      "--out",
      out
    ]);
    const report = JSON.parse(
      await readFile(path.join(out, "migration-result.json"), "utf8")
    );
    const artifactPath = path.join(out, "migrated-artifact.json");
    const artifact = JSON.parse(
      await readFile(artifactPath, "utf8")
    );

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      status: "MIGRATED",
      trustDisposition: "PRESERVED",
      output: {
        artifactRef: "migrated-artifact.json",
        contentHash: await hashFile(artifactPath)
      }
    });
    expect(artifact).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "runtime_manifest"
    });
  }, 30_000);

  test("writes a diagnostic-only result and exits 2 when trust cannot be reconstructed", async () => {
    const input = path.join(root, "observer-qualification.json");
    const out = path.join(root, "out");
    await writeFile(
      input,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          artifactType: "observer-qualification",
          qualificationId:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        null,
        2
      )}\n`
    );

    const result = await awb([
      "artifact",
      "migrate",
      "--input",
      input,
      "--out",
      out
    ]);
    const report = JSON.parse(
      await readFile(path.join(out, "migration-result.json"), "utf8")
    );

    expect(result.exitCode).toBe(2);
    expect(report).toMatchObject({
      status: "DIAGNOSTIC_ONLY",
      reasonCodes: ["ARTIFACT_TRUST_FIELDS_MISSING"]
    });
    await expect(
      readFile(path.join(out, "migrated-artifact.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

async function awb(args: string[]) {
  return execa("npm", ["run", "benchmark", "--", ...args], {
    cwd,
    reject: false
  });
}

function legacyRuntime(): Record<string, unknown> {
  return {
    attemptId: "attempt-cli-legacy",
    runner: {
      schemaVersion: "0.1.0",
      name: "simulated",
      supported: true,
      adapterVersion: "0.1.0",
      executionMode: "simulated",
      supportsEntrypointKinds: ["file", "cli"],
      tokenSourceDetail: {
        source: "estimated",
        confidence: "medium"
      },
      comparability: {
        workflowScore: "comparable",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      },
      capabilitiesHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    mode: "diagnostic",
    dryRun: false,
    seed: "legacy-cli-seed",
    contractHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    caseCount: 1,
    liveTranscriptCount: 0,
    caseSource: "target://materialized"
  };
}
