import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import {
  analyzeReliabilitySamples,
  type ReliabilityPolicy,
  type ReliabilitySample
} from "../src/reliability/reliability.js";

const cwd = process.cwd();
const seed = "schema-fixed-seed";
const policy: ReliabilityPolicy = {
  deterministicMinimumSamples: 5,
  liveMinimumSamples: 20,
  gateConsistencyMinimum: 0.95,
  caseConsistencyMinimum: 0.95,
  maximumMissingRate: 0,
  minimumTelemetryCompleteness: 0.75,
  confidenceLevel: 0.95,
  bootstrapIterations: 200,
  defaultSeed: seed
};

describe("reliability schemas", () => {
  test("validate portable study manifests and reject path-like authority", async () => {
    const validate = await compileSchema("reliability-study.schema.json");
    const manifest = {
      schemaVersion: "0.1.0",
      studyId: "schema-study",
      kind: "deterministic_repeat",
      seed,
      pairs: [
        {
          sampleId: "repeat-1",
          baseline: "baseline",
          candidate: "candidates/repeat-1"
        }
      ]
    };

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, pairs: [] })).toBe(false);
    expect(
      validate({
        ...manifest,
        pairs: [{ ...manifest.pairs[0], baseline: "/private/tmp/run" }]
      })
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        pairs: [{ ...manifest.pairs[0], candidate: "../candidate" }]
      })
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        pairs: [{ ...manifest.pairs[0], candidate: "file://candidate" }]
      })
    ).toBe(false);
  });

  test("validates integrity-bound reports emitted by reliability analysis", async () => {
    const validate = await compileSchema("reliability-report.schema.json");
    const report = analyzeReliabilitySamples(
      {
        studyId: "schema-report",
        kind: "deterministic_repeat",
        seed
      },
      Array.from({ length: 5 }, (_, index) => sample(index + 1)),
      policy
    );

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.integrity.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toContain(cwd);

    expect(
      validate({
        ...report,
        outputPath: "/tmp/reliability-report.json"
      })
    ).toBe(false);
  });
});

async function compileSchema(file: string) {
  const schema = JSON.parse(
    await readFile(path.join(cwd, "schemas", file), "utf8")
  );
  return new Ajv2020({ strict: false }).compile(schema);
}

function sample(
  index: number,
  overrides: Partial<ReliabilitySample> = {}
): ReliabilitySample {
  return {
    status: "observed",
    sampleId: `sample-${index}`,
    evidenceHash: `sha256:${index.toString(16).padStart(64, "0")}`,
    attemptFingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
    baselineRunId: `baseline-${index}`,
    candidateRunId: `candidate-${index}`,
    context: {
      targetId: "fixture-target",
      suite: "smoke",
      contractHash: `sha256:${"a".repeat(64)}`,
      caseSetHash: `sha256:${"b".repeat(64)}`,
      conditionsHash: `sha256:${"c".repeat(64)}`,
      runnerFingerprint: `sha256:${"d".repeat(64)}`,
      environmentFingerprint: `sha256:${"e".repeat(64)}`,
      observerVersion: "not_applicable",
      model: "unspecified",
      permissionMode: "none",
      budgetHash: `sha256:${"f".repeat(64)}`,
      seed,
      executionMode: "simulated",
      evidenceKind: "simulated",
      observationLevel: "synthetic_events",
      observerQualificationStatus: "not_applicable"
    },
    outcome: {
      classification: "UNCHANGED",
      gateDecision: "DIAGNOSTIC_ONLY",
      baselineScore: 100,
      candidateScore: 100,
      scoreDelta: 0,
      telemetryCompleteness: 1,
      dimensions: [
        { dimension: "contract", baseline: 100, candidate: 100 }
      ],
      cases: [
        {
          caseId: "fixture-case",
          candidateVerdict: "PASS",
          candidateHardFailures: []
        }
      ]
    },
    ...overrides
  };
}
