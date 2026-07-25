import { describe, expect, test } from "vitest";
import {
  analyzeReliabilitySamples,
  type ReliabilityPolicy,
  type ReliabilitySample
} from "../src/reliability/reliability.js";

const seed = "stage4-statistics-seed";
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
      targetId: "minimal-directory-agent",
      suite: "smoke",
      contractHash: `sha256:${"a".repeat(64)}`,
      caseSetHash: `sha256:${"b".repeat(64)}`,
      conditionsHash: `sha256:${"c".repeat(64)}`,
      runnerFingerprint: `sha256:${"d".repeat(64)}`,
      environmentFingerprint: `sha256:${"e".repeat(64)}`,
      observerVersion: "1.0.0",
      model: "gpt-test",
      permissionMode: "read_only_no_approval",
      budgetHash: `sha256:${"f".repeat(64)}`,
      seed,
      executionMode: "live",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    outcome: {
      classification: "UNCHANGED",
      gateDecision: "PASS",
      baselineScore: 100,
      candidateScore: 100,
      scoreDelta: 0,
      telemetryCompleteness: 1,
      dimensions: [{ dimension: "contract", baseline: 100, candidate: 100 }],
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

function liveSamples(count: number): ReliabilitySample[] {
  return Array.from({ length: count }, (_, index) => sample(index + 1));
}

describe("reliability statistical hardening", () => {
  test("quarantines multiple fixed execution contexts even when each context is internally stable", () => {
    const samples = liveSamples(20).map((entry, index) =>
      index < 10
        ? entry
        : sample(index + 1, {
            context: {
              ...entry.context,
              observerVersion: "2.0.0",
              model: "gpt-other",
              permissionMode: "runner_default",
              budgetHash: `sha256:${"9".repeat(64)}`
            }
          })
    );

    const report = analyzeReliabilitySamples(
      { studyId: "context-drift", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.metrics.fixedContextDrift).toHaveLength(2);
    expect(report.metrics.fixedContextDrift.every((entry) => entry.status === "DRIFT")).toBe(true);
    expect(report.conclusion).toBe("QUARANTINED");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("case consistency includes sorted hard-failure codes, not only verdict", () => {
    const samples = liveSamples(20).map((entry, index) =>
      index === 19
        ? sample(index + 1, {
            outcome: {
              ...entry.outcome,
              cases: [
                {
                  caseId: "fixture-case",
                  candidateVerdict: "FAIL",
                  candidateHardFailures: [
                    { code: "TARGET_ROUTE_FORBIDDEN", severity: "P0" },
                    { code: "TARGET_OWNER_BYPASS", severity: "P0" }
                  ]
                }
              ]
            }
          })
        : sample(index + 1, {
            outcome: {
              ...entry.outcome,
              cases: [
                {
                  caseId: "fixture-case",
                  candidateVerdict: "FAIL",
                  candidateHardFailures: [
                    { code: "TARGET_OWNER_BYPASS", severity: "P0" },
                    { code: "TARGET_ROUTE_FORBIDDEN", severity: "P0" }
                  ]
                }
              ]
            }
          })
    );

    const report = analyzeReliabilitySamples(
      { studyId: "case-signature", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.metrics.caseConsistency.pointEstimate).toBe(1);
    expect(report.quarantinedCases).toEqual([]);
  });

  test("case consistency counts absent case outcomes instead of dropping them", () => {
    const samples = liveSamples(20).map((entry, index) =>
      index >= 18
        ? sample(index + 1, {
            outcome: {
              ...entry.outcome,
              cases: []
            }
          })
        : entry
    );

    const report = analyzeReliabilitySamples(
      { studyId: "missing-case-outcomes", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.metrics.caseConsistency.pointEstimate).toBe(0.9);
    expect(report.quarantinedCases).toEqual([
      {
        caseId: "fixture-case",
        consistency: 0.9,
        status: "QUARANTINED"
      }
    ]);
  });

  test("duplicate evidence, attempt fingerprints, and candidate run IDs cannot inflate sample size", () => {
    const original = sample(1);
    const samples = [
      original,
      sample(2, {
        attemptFingerprint: original.attemptFingerprint
      }),
      ...Array.from({ length: 18 }, (_, index) => sample(index + 3))
    ];

    const report = analyzeReliabilitySamples(
      { studyId: "duplicates", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.samples).toHaveLength(20);
    expect(report.metrics.sampleSize.requested).toBe(20);
    expect(report.metrics.duplicateEvidenceCount).toBe(1);
    expect(report.conclusion).toBe("QUARANTINED");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("self-comparisons cannot masquerade as independent repeated runs", () => {
    const samples = liveSamples(20).map((entry, index) =>
      sample(index + 1, {
        baselineRunId: entry.candidateRunId,
        candidateRunId: entry.candidateRunId
      })
    );

    const report = analyzeReliabilitySamples(
      { studyId: "self-comparisons", kind: "live_aa", seed },
      samples,
      policy
    );

    expect(report.metrics.duplicateEvidenceCount).toBe(20);
    expect(report.conclusion).toBe("QUARANTINED");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("live A/A requires every observed classification to be UNCHANGED", () => {
    const samples = liveSamples(20).map((entry, index) =>
      index === 19
        ? sample(index + 1, {
            outcome: {
              ...entry.outcome,
              classification: "IMPROVED"
            }
          })
        : entry
    );

    const report = analyzeReliabilitySamples(
      { studyId: "aa-classification", kind: "live_aa", seed },
      samples,
      policy
    );

    expect(report.metrics.aa).toEqual({
      applicable: true,
      unchangedRate: 0.95,
      passed: false
    });
    expect(report.conclusion).toBe("QUARANTINED");
    expect(report.strongConclusionAllowed).toBe(false);
  });

  test("reports P0 observed count and blocks when any P0 candidate is not blocked", () => {
    const p0Diagnostic = sample(1, {
      outcome: {
        ...sample(1).outcome,
        gateDecision: "DIAGNOSTIC_ONLY",
        cases: [
          {
            caseId: "p0-case",
            candidateVerdict: "FAIL",
            candidateHardFailures: [
              { code: "TARGET_ROUTE_FORBIDDEN", severity: "P0" }
            ]
          }
        ]
      }
    });
    const samples = [
      p0Diagnostic,
      ...liveSamples(19).map((entry, index) => sample(index + 2, entry))
    ];

    const report = analyzeReliabilitySamples(
      { studyId: "p0-detection", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.metrics.p0ObservedCount).toBe(1);
    expect(report.metrics.p0DetectionRate).toBe(0);
    expect(report.metrics.p0FalsePassCount).toBe(0);
    expect(report.conclusion).toBe("INVALID");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("BLOCK");
  });
});
