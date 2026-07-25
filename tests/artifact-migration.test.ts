import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  artifactMigrationExitCode,
  migrateArtifact
} from "../src/artifacts/migration.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { profileTarget } from "../src/profiler/profileTarget.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "awb-stage7-migration-"));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Stage 7 artifact migration", () => {
  test("preserves a current schema-valid 0.1.x artifact", async () => {
    const contract = (
      await profileTarget(await loadTargetPack("minimal-directory-agent"))
    ).contract;
    const input = await writeJson("contract-model.json", contract);

    const migration = await migrateArtifact(input);

    expect(migration.result).toMatchObject({
      status: "CURRENT",
      trustDisposition: "PRESERVED",
      source: {
        artifactType: "contract_model",
        schemaVersion: "0.1.0"
      },
      target: {
        schemaVersion: "0.1.0",
        schemaFile: "contract-model.schema.json"
      },
      reasonCodes: []
    });
    expect(migration.artifact).toEqual(contract);
    expect(artifactMigrationExitCode(migration.result)).toBe(0);
  });

  test("normalizes a readable 0.1.x patch artifact to the current patch schema", async () => {
    const contract = (
      await profileTarget(await loadTargetPack("minimal-directory-agent"))
    ).contract;
    const input = await writeJson("contract-model.json", {
      ...contract,
      schemaVersion: "0.1.7"
    });

    const migration = await migrateArtifact(input);

    expect(migration.result).toMatchObject({
      status: "MIGRATED",
      trustDisposition: "PRESERVED",
      source: {
        schemaVersion: "0.1.7",
        versionInferred: false
      },
      target: {
        schemaVersion: "0.1.0"
      },
      reasonCodes: ["ARTIFACT_METADATA_ADDED"]
    });
    expect(migration.artifact).toMatchObject({
      schemaVersion: "0.1.0"
    });
  });

  test("losslessly adds metadata to a readable unversioned runtime manifest", async () => {
    const input = await writeJson("runtime-manifest.json", legacyRuntime());

    const migration = await migrateArtifact(input);

    expect(migration.result).toMatchObject({
      status: "MIGRATED",
      trustDisposition: "PRESERVED",
      source: {
        artifactType: "runtime_manifest",
        schemaVersion: "0.1.0",
        versionInferred: true
      },
      reasonCodes: ["ARTIFACT_METADATA_ADDED"]
    });
    expect(migration.artifact).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "runtime_manifest",
      attemptId: "attempt-legacy"
    });
    expect(artifactMigrationExitCode(migration.result)).toBe(0);
  });

  test("downgrades readable legacy evidence when trusted fields are missing", async () => {
    const input = await writeJson("observer-qualification.json", {
      schemaVersion: "0.1.0",
      artifactType: "observer-qualification",
      qualificationId:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });

    const migration = await migrateArtifact(input);

    expect(migration.artifact).toBeUndefined();
    expect(migration.result).toMatchObject({
      status: "DIAGNOSTIC_ONLY",
      trustDisposition: "DIAGNOSTIC_ONLY",
      reasonCodes: ["ARTIFACT_TRUST_FIELDS_MISSING"]
    });
    expect(migration.result.actions.join(" ")).toMatch(
      /regenerate|trusted|diagnostic/i
    );
    expect(artifactMigrationExitCode(migration.result)).toBe(2);
  });

  test("keeps a legacy suite diagnostic-only when gate policy trust is missing", async () => {
    const input = await writeJson("suite-result.json", {
      schemaVersion: "0.1.0",
      resultType: "suite",
      targetId: "minimal-directory-agent",
      suite: "smoke",
      runId: "legacy-suite",
      releaseDecision: "DIAGNOSTIC_ONLY"
    });

    const migration = await migrateArtifact(input);
    const serialized = JSON.stringify(migration);

    expect(migration.artifact).toBeUndefined();
    expect(migration.result).toMatchObject({
      status: "DIAGNOSTIC_ONLY",
      trustDisposition: "DIAGNOSTIC_ONLY",
      source: {
        artifactType: "suite",
        schemaVersion: "0.1.0",
        versionInferred: false
      },
      reasonCodes: ["ARTIFACT_TRUST_FIELDS_MISSING"]
    });
    expect(serialized).not.toContain("policyHash");
    expect(serialized).not.toContain("rulesHash");
    expect(artifactMigrationExitCode(migration.result)).toBe(2);
  });

  test("returns a stable code and actionable hint for an unsupported version", async () => {
    const contract = (
      await profileTarget(await loadTargetPack("minimal-directory-agent"))
    ).contract;
    const input = await writeJson("contract-model.json", {
      ...contract,
      schemaVersion: "1.0.0"
    });

    const migration = await migrateArtifact(input);

    expect(migration.artifact).toBeUndefined();
    expect(migration.result).toMatchObject({
      status: "INCOMPATIBLE",
      trustDisposition: "REJECTED",
      reasonCodes: ["ARTIFACT_SCHEMA_VERSION_UNSUPPORTED"]
    });
    expect(migration.result.actions.join(" ")).toMatch(
      /compatible AWB|regenerate|migration/i
    );
    expect(artifactMigrationExitCode(migration.result)).toBe(1);
  });

  test("does not infer over an explicitly malformed schema version", async () => {
    const input = await writeJson("runtime-manifest.json", {
      ...legacyRuntime(),
      schemaVersion: 1
    });

    const migration = await migrateArtifact(input);

    expect(migration.artifact).toBeUndefined();
    expect(migration.result).toMatchObject({
      status: "INCOMPATIBLE",
      trustDisposition: "REJECTED",
      source: {
        schemaVersion: null,
        versionInferred: false
      },
      reasonCodes: ["ARTIFACT_SCHEMA_VERSION_INVALID"]
    });
  });

  test("returns stable parse diagnostics without leaking the input path", async () => {
    const input = path.join(root, "runtime-manifest.json");
    await writeFile(input, "{not-json");

    const migration = await migrateArtifact(input);
    const serialized = JSON.stringify(migration.result);

    expect(migration.result).toMatchObject({
      status: "INCOMPATIBLE",
      trustDisposition: "REJECTED",
      reasonCodes: ["ARTIFACT_JSON_INVALID"]
    });
    expect(serialized).not.toContain(root);
    expect(artifactMigrationExitCode(migration.result)).toBe(1);
  });
});

async function writeJson(fileName: string, value: unknown): Promise<string> {
  const filePath = path.join(root, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function legacyRuntime(): Record<string, unknown> {
  return {
    attemptId: "attempt-legacy",
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
    seed: "legacy-seed",
    contractHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    caseCount: 1,
    liveTranscriptCount: 0,
    caseSource: "target://materialized"
  };
}
