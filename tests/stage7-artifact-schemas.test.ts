import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import {
  loadArtifactCompatibilityMatrix,
  loadArtifactSchemaRegistry
} from "../src/artifacts/registry.js";
import type { RuntimeManifest } from "../src/core/types.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { publicProfileEvidence } from "../src/utils/redaction.js";

const cwd = process.cwd();

describe("Stage 7 formal artifact schemas and registry", () => {
  test("registers every formal schema and all release-critical artifact types", async () => {
    const registry = await loadArtifactSchemaRegistry();
    const matrix = await loadArtifactCompatibilityMatrix();
    const schemaFiles = (await readdir(path.join(cwd, "schemas")))
      .filter((file) => file.endsWith(".schema.json"))
      .sort();
    const requiredArtifactTypes = [
      "contract_model",
      "profile_evidence",
      "generation_manifest",
      "runtime_manifest",
      "observer-qualification",
      "reliability_report",
      "external_validity_report"
    ];

    expect(registry.schemaFiles).toEqual(schemaFiles);
    expect(registry.entries.map((entry) => entry.artifactType)).toEqual(
      expect.arrayContaining(requiredArtifactTypes)
    );
    expect(matrix.policies.map((policy) => policy.artifactType)).toEqual(
      expect.arrayContaining(requiredArtifactTypes)
    );
    expect(
      matrix.policies.every(
        (policy) =>
          policy.currentVersion === "0.1.0" &&
          policy.readableVersions.includes("0.1.x") &&
          policy.missingTrustDisposition === "DIAGNOSTIC_ONLY"
      )
    ).toBe(true);
  });

  test("validates current ContractModel, public profile evidence, and generation manifest", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const generationManifest = materializeSmokeSuite(profile.contract).manifest;
    const publicEvidence = publicProfileEvidence(profile.evidence);

    await expectValid("contract-model.schema.json", profile.contract);
    await expectValid("profile-evidence.schema.json", publicEvidence);
    await expectValid("generation-manifest.schema.json", generationManifest);

    expect(publicEvidence).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "profile_evidence",
      root: "target://root"
    });
    expect(generationManifest).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "generation_manifest"
    });
    expect(JSON.stringify(publicEvidence)).not.toContain("excerpt");
  });

  test("rejects private or non-portable paths in public profile evidence", async () => {
    const profile = await profileTarget(
      await loadTargetPack("minimal-directory-agent")
    );
    const publicEvidence = publicProfileEvidence(profile.evidence);

    const absoluteScannedPath = structuredClone(publicEvidence);
    absoluteScannedPath.scannedFiles[0]!.path = [
      "/",
      "Users",
      "/",
      "example",
      "/",
      "private-agent.md"
    ].join("");
    await expectInvalid(
      "profile-evidence.schema.json",
      absoluteScannedPath
    );

    const traversingMissingPath = structuredClone(publicEvidence);
    traversingMissingPath.missingFiles = [["..", "private-agent.md"].join("/")];
    await expectInvalid(
      "profile-evidence.schema.json",
      traversingMissingPath
    );

    const sensitiveWarning = structuredClone(publicEvidence);
    sensitiveWarning.warnings = [
      [
        "Inspect ",
        ["/", "private", "/", "tmp", "/", "agent-workflow"].join(""),
        " or contact ",
        ["owner", "example.com"].join("@"),
        "."
      ].join("")
    ];
    await expectInvalid("profile-evidence.schema.json", sensitiveWarning);
  });

  test("validates a complete runtime manifest and rejects missing execution identity", async () => {
    const runtime = runtimeManifest();
    await expectValid("runtime-manifest.schema.json", runtime);

    const missingAttempt = structuredClone(runtime) as Partial<RuntimeManifest>;
    delete missingAttempt.attemptId;
    await expectInvalid("runtime-manifest.schema.json", missingAttempt);
  });
});

async function expectValid(schemaName: string, value: unknown): Promise<void> {
  const validate = await validator(schemaName);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

async function expectInvalid(schemaName: string, value: unknown): Promise<void> {
  const validate = await validator(schemaName);
  expect(validate(value)).toBe(false);
}

async function validator(schemaName: string) {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", schemaName), "utf8")
  ) as object;
  return new Ajv2020({ strict: false }).compile(schema);
}

function runtimeManifest(): RuntimeManifest {
  return {
    schemaVersion: "0.1.0",
    artifactType: "runtime_manifest",
    attemptId: "attempt-stage7",
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
    seed: "stage7-fixed-seed",
    contractHash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    caseCount: 1,
    liveTranscriptCount: 0,
    caseSource: "target://materialized"
  };
}
