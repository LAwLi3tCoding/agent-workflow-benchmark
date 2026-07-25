import { describe, expect, test } from "vitest";
import {
  analyzeReliabilitySamples,
  type ReliabilityPolicy,
  type ReliabilitySample
} from "../src/reliability/reliability.js";

const seed = "stage4-evidence-boundary-seed";
const policy: ReliabilityPolicy = {
  deterministicMinimumSamples: 5,
  liveMinimumSamples: 20,
  gateConsistencyMinimum: 0.95,
  caseConsistencyMinimum: 0.95,
  maximumMissingRate: 0,
  minimumTelemetryCompleteness: 0.75,
  confidenceLevel: 0.95,
  bootstrapIterations: 200,
  defaultSeed: "awb-default-seed-v1"
};

describe("reliability evidence boundary", () => {
  test("capability-only repeats cannot become a strong deterministic conclusion", () => {
    const samples = Array.from({ length: 5 }, (_, index) =>
      sample(index + 1, {
        context: {
          ...sample(index + 1).context,
          executionMode: "unknown",
          evidenceKind: "unknown",
          observationLevel: "capability_only"
        } as ReliabilitySample["context"]
      })
    );

    const report = analyzeReliabilitySamples(
      {
        studyId: "capability-only-repeat",
        kind: "deterministic_repeat",
        seed
      },
      samples,
      policy
    );

    expect(report.conclusion).toBe("INSUFFICIENT_SAMPLE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("sample seeds must match the study seed even for the exported analyzer API", () => {
    const samples = Array.from({ length: 5 }, (_, index) =>
      sample(index + 1, {
        context: {
          ...sample(index + 1).context,
          seed: "different-sample-seed"
        }
      })
    );

    const report = analyzeReliabilitySamples(
      {
        studyId: "wrong-sample-seed",
        kind: "deterministic_repeat",
        seed
      },
      samples,
      policy
    );

    expect(report.conclusion).toBe("INSUFFICIENT_SAMPLE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });
});

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
      dimensions: [],
      cases: []
    },
    ...overrides
  };
}
