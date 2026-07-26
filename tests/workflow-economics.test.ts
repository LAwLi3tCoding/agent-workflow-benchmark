import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { RunEvent, SuiteResult } from "../src/core/types.js";
import { buildTraceDiff, type TraceDiff } from "../src/report/traceDiff.js";
import {
  buildTrajectoryReview,
  type TrajectoryReviewReport
} from "../src/report/trajectoryReview.js";
import {
  assertWorkflowEconomicsReportIntegrity,
  buildWorkflowEconomicsReport,
  renderWorkflowEconomicsMarkdown
} from "../src/report/workflowEconomics.js";
import { createAjv2020 } from "../src/utils/jsonSchema.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

let tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("workflow economics report", () => {
  test("builds an always diagnostic quality-cost-latency report from bound artifacts", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 120, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "FAIL", 40, 700, 100, 30, 12),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);

    const report = buildWorkflowEconomicsReport({
      traceDiff,
      traceDiffRef: "trace-diff.json",
      traceDiffHash: sha256Text(stableJson(traceDiff)),
      trajectoryReview: review,
      trajectoryReviewRef: "trajectory-review.json",
      trajectoryReviewHash: sha256Text(stableJson(review)),
      baselineSuite,
      baselineSuiteRef: "baseline/suite-result.json",
      baselineSuiteHash: sha256Text(stableJson(baselineSuite)),
      candidateSuite,
      candidateSuiteRef: "candidate/suite-result.json",
      candidateSuiteHash: sha256Text(stableJson(candidateSuite)),
      generatedAt: "2026-07-26T00:00:00.000Z"
    });

    expect(report.artifactType).toBe("workflow_economics_report");
    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.gateAuthority).toBe("NONE");
    expect(report.metricAvailability.planToAction.status).toBe("UNAVAILABLE");
    expect(report.metricAvailability.replanning.status).toBe("UNAVAILABLE");
    expect(report.metricAvailability.confidenceIntervals.status).toBe("UNAVAILABLE");
    expect(report.methodology).toMatchObject({
      qualityMetric: "cappedScore",
      qualityScale: "0_to_100"
    });
    expect(report.summary).toMatchObject({
      caseCount: 2,
      candidateDominates: 1,
      tradeoff: 1,
      incomparable: 0
    });
    const route = report.cases.find((entry) => entry.caseId === "case-route");
    expect(route).toMatchObject({
      pareto: "TRADEOFF",
      baseline: {
        tokens: {
          status: "AVAILABLE",
          input: 1000,
          output: 120,
          total: 1120,
          wasted: 50,
          confidence: "high"
        },
        wallClock: { status: "AVAILABLE", seconds: 20 }
      },
      candidate: {
        tokens: {
          status: "AVAILABLE",
          input: 700,
          output: 100,
          total: 800,
          wasted: 30,
          confidence: "high"
        },
        wallClock: { status: "AVAILABLE", seconds: 12 }
      },
      deltas: {
        qualityScoreDelta: -50,
        tokenTotalDelta: -320,
        wastedTokenDelta: -20,
        wallClockSecondsDelta: -8
      },
      validationLatency: {
        status: "AVAILABLE",
        detectionLatencySteps: 2,
        detectionRef: "candidate:workflow-trace.json#event=c-route-failure"
      },
      recovery: {
        status: "AVAILABLE",
        attempts: 0,
        outcome: "not_attempted"
      },
      retryEvidence: {
        status: "AVAILABLE",
        repeatedActionRefs: [
          "candidate:workflow-trace.json#event=c-route-tool-a",
          "candidate:workflow-trace.json#event=c-route-tool-b"
        ]
      },
      irreversibleSideEffectTiming: {
        status: "AVAILABLE",
        firstPosition: 3,
        refs: ["candidate:workflow-trace.json#event=c-route-side-effect"]
      }
    });
    expect(report.cases.find((entry) => entry.caseId === "case-fast")?.pareto).toBe(
      "CANDIDATE_DOMINATES"
    );
    assertWorkflowEconomicsReportIntegrity(report);
    expect(renderWorkflowEconomicsMarkdown(report)).toContain("DIAGNOSTIC_ONLY");
  });

  test("rejects tampered source artifacts and trajectory-review trace binding mismatches", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "FAIL", 40, 700, 100, 30, 12),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);
    const tamperedTrace = structuredClone(traceDiff);
    tamperedTrace.comparability.status = "INCOMPARABLE";
    expect(() =>
      buildWorkflowEconomicsReport(input(tamperedTrace, review, baselineSuite, candidateSuite))
    ).toThrow(/trace diff integrity/i);

    const mismatchedReview = structuredClone(review);
    mismatchedReview.source.traceDiffContentHash = HASH_A;
    const { integrity: _ignored, ...content } = mismatchedReview;
    mismatchedReview.integrity.contentHash = sha256Text(stableJson(content));
    expect(() =>
      buildWorkflowEconomicsReport(input(traceDiff, mismatchedReview, baselineSuite, candidateSuite))
    ).toThrow(/trajectory review.*trace diff/i);
  });

  test("requires matched target, suite, and case sets across source artifacts", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "FAIL", 40, 700, 100, 30, 12)
    ]);

    expect(() =>
      buildWorkflowEconomicsReport(input(traceDiff, review, baselineSuite, candidateSuite))
    ).toThrow(/case set/i);

    const wrongSuite = { ...baselineSuite, suite: "regression" };
    expect(() =>
      buildWorkflowEconomicsReport(input(traceDiff, review, wrongSuite, baselineSuite))
    ).toThrow(/targetId and suite/i);
  });

  test("requires an explicit canonical report timestamp", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "PASS", 90, 900, 90, 40, 18),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);

    expect(() =>
      buildWorkflowEconomicsReport({
        ...input(traceDiff, review, baselineSuite, candidateSuite),
        generatedAt: "not-a-timestamp"
      })
    ).toThrow(/canonical generatedAt/iu);
  });

  test("rejects capped quality outside the AWB 0-100 scale", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 101, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "PASS", 90, 900, 90, 40, 18),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);

    expect(() =>
      buildWorkflowEconomicsReport(
        input(traceDiff, review, baselineSuite, candidateSuite)
      )
    ).toThrow(/invalid capped quality score/iu);
  });

  test("keeps missing metrics and incomparable traces from making the candidate look better", () => {
    const traceDiff = economicsTraceDiff({
      comparability: { status: "INCOMPARABLE", reasons: ["trace hashes do not share a qualified observer"] }
    });
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "PASS", 95, undefined, undefined, undefined, undefined),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);

    const report = buildWorkflowEconomicsReport(
      input(traceDiff, review, baselineSuite, candidateSuite)
    );

    expect(report.comparability.status).toBe("INCOMPARABLE");
    expect(report.summary.candidateDominates).toBe(0);
    expect(report.cases.every((entry) => entry.pareto === "INCOMPARABLE")).toBe(true);
    expect(report.cases.find((entry) => entry.caseId === "case-route")?.missingness).toContainEqual({
      lane: "candidate",
      metric: "tokens",
      reason: "Token ledger is absent from candidate suite case result."
    });
  });

  test("makes the aggregate incomparable for missing economics evidence or gate-policy drift", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "PASS", 95, undefined, undefined, undefined, undefined),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);
    const missing = buildWorkflowEconomicsReport(
      input(traceDiff, review, baselineSuite, candidateSuite)
    );

    expect(missing.comparability.status).toBe("INCOMPARABLE");
    expect(missing.comparability.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/candidate\.tokens/iu),
        expect.stringMatching(/candidate\.wallClock/iu)
      ])
    );

    const driftedCandidate = structuredClone(baselineSuite);
    driftedCandidate.runId = "candidate-run";
    driftedCandidate.gatePolicy = {
      ...driftedCandidate.gatePolicy,
      policyVersion: "9.9.9",
      policyHash: `sha256:${"c".repeat(64)}`
    };
    const drift = buildWorkflowEconomicsReport(
      input(traceDiff, review, baselineSuite, driftedCandidate)
    );
    expect(drift.comparability.status).toBe("INCOMPARABLE");
    expect(drift.comparability.reasons).toContain(
      "baseline and candidate gate-policy bindings differ"
    );
    expect(drift.cases.every((entry) => entry.pareto === "INCOMPARABLE")).toBe(
      true
    );
  });

  test("keeps low-confidence token deltas visible but excludes Pareto dominance", () => {
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 100, 50, 20, "low"),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30, "low")
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "PASS", 95, 700, 100, 30, 12, "low"),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25, "low")
    ]);

    const report = buildWorkflowEconomicsReport(
      input(traceDiff, review, baselineSuite, candidateSuite)
    );
    expect(report.comparability.status).toBe("INCOMPARABLE");
    expect(report.cases.every((entry) => entry.pareto === "INCOMPARABLE")).toBe(
      true
    );
    expect(report.cases[0]?.deltas.tokenTotalDelta).toBeTypeOf("number");
    expect(report.comparability.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/baseline\.tokenConfidence/iu),
        expect.stringMatching(/candidate\.tokenConfidence/iu)
      ])
    );
  });

  test("validates the JSON schema and CLI writes JSON plus Markdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-workflow-economics-"));
    tempRoots.push(root);
    const out = path.join(root, "out");
    await mkdir(out);
    const traceDiff = economicsTraceDiff();
    const review = trajectoryReview(traceDiff);
    const baselineSuite = suiteResult("baseline-run", [
      caseResult("case-route", "PASS", 90, 1000, 120, 50, 20),
      caseResult("case-fast", "PASS", 70, 1200, 200, 80, 30)
    ]);
    const candidateSuite = suiteResult("candidate-run", [
      caseResult("case-route", "FAIL", 40, 700, 100, 30, 12),
      caseResult("case-fast", "PASS", 80, 1000, 160, 70, 25)
    ]);
    const tracePath = path.join(root, "trace-diff.json");
    const reviewPath = path.join(root, "trajectory-review.json");
    const baselinePath = path.join(root, "baseline-suite-result.json");
    const candidatePath = path.join(root, "candidate-suite-result.json");
    await writeFile(tracePath, `${JSON.stringify(traceDiff, null, 2)}\n`);
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    await writeFile(baselinePath, `${JSON.stringify(baselineSuite, null, 2)}\n`);
    await writeFile(candidatePath, `${JSON.stringify(candidateSuite, null, 2)}\n`);

    const report = buildWorkflowEconomicsReport(
      input(traceDiff, review, baselineSuite, candidateSuite)
    );
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas/workflow-economics-report.schema.json"),
        "utf8"
      )
    );
    const ajv = createAjv2020();
    const validate = ajv.compile(schema);
    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);

    const execution = await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "report",
        "workflow-economics",
        "--trace-diff",
        tracePath,
        "--trajectory-review",
        reviewPath,
        "--baseline-suite",
        baselinePath,
        "--candidate-suite",
        candidatePath,
        "--generated-at",
        "2026-07-26T00:00:00.000Z",
        "--out",
        out
      ],
      { reject: false }
    );
    expect(execution.exitCode).toBe(2);
    expect(await readFile(path.join(out, "workflow-economics-report.md"), "utf8")).toContain(
      "Workflow Economics"
    );
    const cliReport = JSON.parse(
      await readFile(path.join(out, "workflow-economics-report.json"), "utf8")
    );
    expect(cliReport.status).toBe("DIAGNOSTIC_ONLY");
    expect(cliReport.gateAuthority).toBe("NONE");

    const invalidReview = {
      ...review,
      unexpected: "schema drift"
    };
    await writeFile(
      reviewPath,
      `${JSON.stringify(invalidReview, null, 2)}\n`
    );
    const rejected = await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "report",
        "workflow-economics",
        "--trace-diff",
        tracePath,
        "--trajectory-review",
        reviewPath,
        "--baseline-suite",
        baselinePath,
        "--candidate-suite",
        candidatePath,
        "--generated-at",
        "2026-07-26T00:00:00.000Z",
        "--out",
        out
      ],
      { reject: false }
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toMatch(/trajectory review.*schema/iu);
  });
});

function input(
  traceDiff: TraceDiff,
  trajectoryReview: TrajectoryReviewReport,
  baselineSuite: SuiteResult,
  candidateSuite: SuiteResult
) {
  return {
    traceDiff,
    traceDiffRef: "trace-diff.json",
    traceDiffHash: sha256Text(stableJson(traceDiff)),
    trajectoryReview,
    trajectoryReviewRef: "trajectory-review.json",
    trajectoryReviewHash: sha256Text(stableJson(trajectoryReview)),
    baselineSuite,
    baselineSuiteRef: "baseline/suite-result.json",
    baselineSuiteHash: sha256Text(stableJson(baselineSuite)),
    candidateSuite,
    candidateSuiteRef: "candidate/suite-result.json",
    candidateSuiteHash: sha256Text(stableJson(candidateSuite)),
    generatedAt: "2026-07-26T00:00:00.000Z"
  };
}

function trajectoryReview(traceDiff: TraceDiff) {
  return buildTrajectoryReview({
    traceDiff,
    traceDiffRef: "trace-diff.json",
    traceDiffHash: sha256Text(stableJson(traceDiff))
  });
}

function economicsTraceDiff(input?: {
  comparability?: { status: "COMPARABLE" | "INCOMPARABLE"; reasons: string[] };
}) {
  return buildTraceDiff({
    mode: "baseline_candidate",
    targetId: "target-a",
    suite: "smoke",
    comparability: input?.comparability ?? { status: "COMPARABLE", reasons: [] },
    baseline: trace("baseline", [
      traceCase("case-route", [
        event("b-route-start", "case_start", "runner", {}),
        event("b-route-tool-a", "tool_call", "runner", { tool: "edit" }),
        event("b-route-gate", "gate_decision", "runner", { status: "PASS" })
      ]),
      traceCase("case-fast", [
        event("b-fast-start", "case_start", "runner", {}),
        event("b-fast-gate", "gate_decision", "runner", { status: "PASS" })
      ])
    ]),
    candidate: trace("candidate", [
      traceCase("case-route", [
        event("c-route-start", "case_start", "runner", {}),
        event("c-route-tool-a", "tool_call", "runner", { tool: "edit" }),
        event("c-route-tool-b", "tool_call", "runner", { tool: "edit" }),
        event("c-route-side-effect", "side_effect_attempt", "runner", {
          action: "deploy",
          attempted: true,
          allowed: true,
          irreversible: true
        }),
        event("c-route-failure", "hard_failure", "observer", {
          code: "PRODUCTION_SIDE_EFFECT"
        })
      ]),
      traceCase("case-fast", [
        event("c-fast-start", "case_start", "runner", {}),
        event("c-fast-gate", "gate_decision", "runner", { status: "PASS" })
      ])
    ])
  });
}

function trace(label: string, cases: Array<{ caseId: string; events: RunEvent[] }>) {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: sha256Text(`${label}:${stableJson(cases)}`),
    cases
  };
}

function traceCase(caseId: string, events: RunEvent[]) {
  return { caseId, templateId: `${caseId}-template`, events };
}

function event(
  eventId: string,
  type: RunEvent["type"],
  actor: string,
  payload: Record<string, unknown>
): RunEvent {
  return {
    eventId,
    timestamp: `2026-07-26T00:00:0${eventId.length % 10}.000Z`,
    type,
    actor,
    payload
  };
}

function suiteResult(runId: string, caseResults: SuiteResult["caseResults"]): SuiteResult {
  return {
    schemaVersion: "0.1.0",
    resultType: "suite",
    targetId: "target-a",
    suite: "smoke",
    runId,
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "0.1.0",
      policyHash: HASH_A,
      rulesHash: HASH_B
    },
    caseResults,
    dimensionScores: [],
    recommendations: [],
    p0CaseRecords: [],
    contractDiagnostics: [],
    rawSuiteScore: average(caseResults.map((entry) => entry.rawScore)),
    cappedSuiteScore: average(caseResults.map((entry) => entry.cappedScore)),
    releaseDecision: "DIAGNOSTIC_ONLY",
    releaseRuleId: "diagnostic-fixture",
    telemetryCompleteness: 1,
    debugHealth: {
      status: "NOT_RUN",
      mutationKillRate: null,
      falseNegativeCount: null,
      falsePositiveCount: null,
      environmentReproducibility: null,
      lastReverseValidationRunId: null,
      doesNotAffectTargetScore: true
    }
  };
}

function caseResult(
  caseId: string,
  verdict: SuiteResult["caseResults"][number]["verdict"],
  cappedScore: number,
  inputTokens?: number,
  outputTokens?: number,
  wastedTokens?: number,
  wallClockSeconds?: number,
  costEstimateConfidence: "high" | "medium" | "low" = "high"
): SuiteResult["caseResults"][number] {
  return {
    caseId,
    verdict,
    rawScore: cappedScore,
    cappedScore,
    hardFailures: [],
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : {
          tokens: {
            input: inputTokens,
            output: outputTokens,
            total: inputTokens + outputTokens,
            wasted: wastedTokens ?? 0,
            costEstimateConfidence
          }
        }),
    ...(wallClockSeconds === undefined
      ? {}
      : {
          efficiency: {
            wallClockSeconds
          }
        })
  } as SuiteResult["caseResults"][number];
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
