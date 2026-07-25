import { describe, expect, test } from "vitest";
import { buildDecisionReport } from "../src/report/decisionReport.js";
import { renderReadOnlyHtmlViewer } from "../src/report/htmlViewer.js";

describe("Stage 9 report rendering performance", () => {
  test("renders large decision reports and viewer HTML within a bounded synchronous budget", () => {
    const comparison = largeComparison(1_000);
    const start = performance.now();
    const report = buildDecisionReport({ comparison, gate: gateResult() });
    const html = renderReadOnlyHtmlViewer({
      title: "Large Stage 9 Report",
      decisionReport: report,
      comparison,
      traceDiff: { artifactType: "trace_diff", caseDiffs: [] }
    });
    const elapsedMs = performance.now() - start;

    expect(report.caseImpacts).toHaveLength(1_000);
    expect(html.length).toBeLessThan(2_000_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

function largeComparison(size: number): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: hash("a"),
      policyHash: hash("b")
    },
    baseline: {
      targetId: "target-a",
      suite: "full",
      runId: "baseline",
      releaseDecision: "APPROVE",
      score: 95,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    candidate: {
      targetId: "target-a",
      suite: "full",
      runId: "candidate",
      releaseDecision: "DIAGNOSTIC_ONLY",
      score: 94,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    comparability: { status: "COMPARABLE", reasons: [] },
    classification: "UNCHANGED",
    scoreDelta: -1,
    caseDeltas: Array.from({ length: size }, (_, index) => ({
      caseId: `case-${index.toString().padStart(4, "0")}`,
      classification: "UNCHANGED",
      baselineVerdict: "PASS",
      candidateVerdict: "PASS",
      scoreDelta: 0,
      newHardFailures: [],
      resolvedHardFailures: []
    })),
    summary: {
      improved: 0,
      regressed: 0,
      unchanged: size,
      hardFailure: 0,
      incomparable: 0
    },
    hardFailures: [],
    evidenceRefs: {
      baseline: ["baseline:workflow-trace.json"],
      candidate: ["candidate:workflow-trace.json"]
    },
    integrity: {
      status: "VERIFIED_AT_WRITE",
      comparisonHash: hash("c"),
      baselineRef: "evidence/baseline",
      candidateRef: "evidence/candidate",
      artifacts: []
    }
  };
}

function gateResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    decision: "DIAGNOSTIC_ONLY",
    ruleId: "GATE-CANDIDATE-DIAGNOSTIC",
    targetId: "target-a",
    suite: "full",
    comparisonClassification: "UNCHANGED",
    comparisonIntegrity: "VALID",
    evidenceRefs: ["comparison:comparison-result.json"],
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: hash("a"),
      policyHash: hash("b")
    }
  };
}

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
