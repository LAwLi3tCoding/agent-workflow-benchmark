import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertTrialMetricsReportIntegrity,
  buildTrialMetricsReport,
  renderTrialMetricsMarkdown,
  type TrialMetricsSourceReport
} from "../src/report/trialMetrics.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";
import { createAjv2020 } from "../src/utils/jsonSchema.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const HASH_E = `sha256:${"e".repeat(64)}`;

let tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("trial metrics report", () => {
  test("computes Inspect-compatible pass@k and pass^k from PASS-only successes", () => {
    const source = reliabilityReport([
      sample("trial-1", "PASS", HASH_A, "run-a"),
      sample("trial-2", "PASS", HASH_B, "run-b"),
      sample("trial-3", "BLOCK", HASH_C, "run-c"),
      sample("trial-4", "DIAGNOSTIC_ONLY", HASH_D, "run-d")
    ]);

    const report = buildTrialMetricsReport({
      source,
      sourceRef: "reliability-report.json",
      sourceHash: sha256Text(stableJson(source)),
      kValues: [1, 2, 3, 4]
    });

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.reasonCodes).toContain("SOURCE_NOT_INDEPENDENTLY_VERIFIED");
    expect(report.counts).toMatchObject({
      trials: 4,
      successes: 2,
      blocks: 1,
      diagnosticOnly: 1
    });
    expect(report.metrics).toEqual([
      { k: 1, passAtK: 0.5, passK: 0.5 },
      { k: 2, passAtK: 0.833333333333, passK: 0.166666666667 },
      { k: 3, passAtK: 1, passK: 0 },
      { k: 4, passAtK: 1, passK: 0 }
    ]);
    assertTrialMetricsReportIntegrity(report);
  });

  test("keeps simulated and unqualified reliability evidence diagnostic-only", () => {
    const source = reliabilityReport([
      sample("trial-1", "PASS", HASH_A, "run-a", {
        executionMode: "simulated",
        evidenceKind: "simulated",
        observationLevel: "synthetic_events",
        observerQualificationStatus: "not_applicable"
      }),
      sample("trial-2", "PASS", HASH_B, "run-b", {
        observerQualificationStatus: "missing"
      })
    ]);

    const report = buildTrialMetricsReport({
      source,
      sourceRef: "reliability-report.json",
      sourceHash: sha256Text(stableJson(source))
    });

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.evidenceEligibility).toMatchObject({
      eligible: false,
      liveWorkflowTraceCount: 1,
      qualifiedObserverCount: 0
    });
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "TRIAL_EVIDENCE_NOT_ALL_LIVE_WORKFLOW_TRACE",
        "TRIAL_EVIDENCE_NOT_ALL_QUALIFIED"
      ])
    );
  });

  test("does not PASS a forged self-consistent live-looking reliability report", () => {
    const source = reliabilityReport([
      sample("trial-1", "PASS", HASH_A, "run-a"),
      sample("trial-2", "PASS", HASH_B, "run-b")
    ]);
    const forged = {
      ...source,
      integrity: {
        status: "VERIFIED_AT_WRITE" as const,
        contentHash: ""
      }
    };
    const { integrity: _ignored, ...content } = forged;
    forged.integrity.contentHash = sha256Text(stableJson(content));

    const report = buildTrialMetricsReport({
      source: forged,
      sourceRef: "reliability-report.json",
      sourceHash: sha256Text(stableJson(forged))
    });

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.reasonCodes).toContain("SOURCE_NOT_INDEPENDENTLY_VERIFIED");
    expect(report.evidenceEligibility.eligible).toBe(true);
    expect(report.counts.successes).toBe(2);
  });

  test("rejects invalid source hashes, tampered source integrity, and invalid k values", () => {
    const source = reliabilityReport([sample("trial-1", "PASS", HASH_A, "run-a")]);
    expect(() =>
      buildTrialMetricsReport({
        source,
        sourceRef: "reliability-report.json",
        sourceHash: "not-a-hash"
      })
    ).toThrow(/source hash is invalid/);
    expect(() =>
      buildTrialMetricsReport({
        source,
        sourceRef: "reliability-report.json",
        sourceHash: HASH_B
      })
    ).toThrow(/source hash does not match/);
    const tampered = structuredClone(source);
    tampered.conclusion = "INVALID";
    expect(() =>
      buildTrialMetricsReport({
        source: tampered,
        sourceRef: "reliability-report.json",
        sourceHash: HASH_B
      })
    ).toThrow(/content integrity verification failed/);
    expect(() =>
      buildTrialMetricsReport({
        source,
        sourceRef: "reliability-report.json",
        sourceHash: sha256Text(stableJson(source)),
        kValues: [0]
      })
    ).toThrow(/k values must be integers/);
  });

  test("report output validates schema and schema-invalid reliability input is rejected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-trial-metrics-"));
    tempRoots.push(root);
    const input = path.join(root, "reliability-report.json");
    const out = path.join(root, "out");
    await mkdir(out);
    const source = reliabilityReport([
      sample("trial-1", "PASS", HASH_A, "run-a"),
      sample("trial-2", "BLOCK", HASH_B, "run-b")
    ]);
    await writeFile(input, `${JSON.stringify(source, null, 2)}\n`);

    const report = buildTrialMetricsReport({
      source: JSON.parse(await readFile(input, "utf8")),
      sourceRef: "reliability-report.json",
      sourceHash: sha256Text(stableJson(source)),
      kValues: [1, 2]
    });
    await writeFile(
      path.join(out, "trial-metrics-report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    await writeFile(
      path.join(out, "trial-metrics-report.md"),
      `${renderTrialMetricsMarkdown(report)}\n`
    );
    const schema = JSON.parse(
      await readFile(path.join(process.cwd(), "schemas/trial-metrics-report.schema.json"), "utf8")
    );
    const ajv = createAjv2020();
    const validate = ajv.compile(schema);
    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
    expect(
      await readFile(path.join(out, "trial-metrics-report.md"), "utf8")
    ).toContain("pass@2");

    const invalid = path.join(root, "invalid.json");
    await writeFile(invalid, `${JSON.stringify({ resultType: "reliability_report" })}\n`);
    const reliabilitySchema = JSON.parse(
      await readFile(path.join(process.cwd(), "schemas/reliability-report.schema.json"), "utf8")
    );
    const validateReliability = ajv.compile(reliabilitySchema);
    const invalidReliability = JSON.parse(await readFile(invalid, "utf8"));
    expect(validateReliability(invalidReliability)).toBe(false);
  });
});

function reliabilityReport(samples: TrialMetricsSourceReport["samples"]): TrialMetricsSourceReport {
  const withoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    resultType: "reliability_report" as const,
    study: {
      studyId: "trial-study",
      kind: "live_paired" as const,
      seed: "seed-1"
    },
    policy: {
      deterministicMinimumSamples: 3,
      liveMinimumSamples: 2,
      gateConsistencyMinimum: 0.8,
      caseConsistencyMinimum: 0.8,
      maximumMissingRate: 0,
      minimumTelemetryCompleteness: 0.8,
      confidenceLevel: 0.95,
      bootstrapIterations: 100,
      defaultSeed: "seed-1"
    },
    conclusion: "RELIABLE" as const,
    strongConclusionAllowed: true,
    gateEligibility: "ELIGIBLE" as const,
    metrics: {
      sampleSize: {
        requested: samples.length,
        observed: samples.length,
        missing: 0,
        minimum: 2
      },
      missingRate: 0,
      telemetryCompleteness: {
        mean: 1,
        variance: 0,
        interval: { kind: "bootstrap" as const, confidenceLevel: 0.95, lower: 1, upper: 1 }
      },
      deterministicAgreement: 1,
      gateConsistency: {
        pointEstimate: 1,
        interval: { kind: "wilson" as const, confidenceLevel: 0.95, lower: 1, upper: 1 }
      },
      caseConsistency: {
        pointEstimate: 1,
        interval: { kind: "wilson" as const, confidenceLevel: 0.95, lower: 1, upper: 1 }
      },
      pairedDelta: {
        mean: 0,
        variance: 0,
        interval: { kind: "bootstrap" as const, confidenceLevel: 0.95, lower: 0, upper: 0 }
      },
      p0FalsePassCount: 0,
      p0ObservedCount: 0,
      p0DetectionRate: null,
      duplicateEvidenceCount: 0,
      aa: { applicable: false, unchangedRate: 0, passed: true },
      dimensionVariance: [],
      fixedContextDrift: []
    },
    quarantinedCases: [],
    debugHealth: {
      status: "PASS" as const,
      environmentReproducibility: 1,
      doesNotAffectTargetScore: true as const
    },
    samples
  };
  return {
    ...withoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(withoutIntegrity))
    }
  };
}

function sample(
  sampleId: string,
  gateDecision: "PASS" | "BLOCK" | "DIAGNOSTIC_ONLY",
  attemptFingerprint: string,
  candidateRunId: string,
  contextOverrides: Partial<TrialMetricsSourceReport["samples"][number]["context"]> = {}
): TrialMetricsSourceReport["samples"][number] {
  return {
    status: "observed",
    sampleId,
    evidenceHash: attemptFingerprint,
    attemptFingerprint,
    baselineRunId: `base-${candidateRunId}`,
    candidateRunId,
    context: {
      targetId: "minimal-directory-agent",
      suite: "trial-suite",
      contractHash: HASH_A,
      caseSetHash: HASH_B,
      conditionsHash: HASH_C,
      runnerFingerprint: HASH_D,
      environmentFingerprint: HASH_E,
      observerVersion: "1.0.0",
      model: "codex",
      permissionMode: "read_only_no_approval",
      budgetHash: HASH_A,
      seed: "seed-1",
      executionMode: "live",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid",
      ...contextOverrides
    },
    outcome: {
      classification: "UNCHANGED",
      gateDecision,
      baselineScore: 90,
      candidateScore: 90,
      scoreDelta: 0,
      telemetryCompleteness: 1,
      dimensions: [],
      cases: [
        {
          caseId: "case-1",
          candidateVerdict: gateDecision === "PASS" ? "PASS" : "FAIL",
          candidateHardFailures: []
        }
      ]
    }
  };
}
