import { describe, expect, test } from "vitest";
import {
  buildDecisionReport,
  renderDecisionReportMarkdown
} from "../src/report/decisionReport.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("Stage 9 decision report", () => {
  test("summarizes maintainer and decision-maker fields with evidence, retest, and statistics", () => {
    const report = buildDecisionReport({
      comparison: comparisonResult(),
      gate: gateResult(),
      reliability: {
        resultType: "reliability_report",
        conclusion: "QUARANTINED",
        gateEligibility: "DIAGNOSTIC_ONLY",
        metrics: {
          sampleSize: { requested: 20, observed: 20, minimum: 20 },
          missingRate: 0.05,
          dimensionVariance: [
            { dimension: "routing", variance: 0.12 }
          ],
          pairedDelta: {
            score: -8,
            interval: { lower: -12, upper: -4 }
          }
        },
        quarantinedCases: ["case-route"]
      },
      validity: {
        resultType: "validity_report",
        status: "INSUFFICIENT_EVIDENCE",
        metrics: {
          sampleSize: { observed: 119, required: 120 },
          p0Recall: 1,
          falsePassCount: 0,
          overallAgreement: 0.84,
          cohenKappa: 0.79
        }
      }
    });

    expect(report).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "decision_report",
      targetId: "target-a",
      suite: "smoke",
      gateDecision: "BLOCK",
      classification: "REGRESSED",
      policyVersion: "1.0.0"
    });
    expect(report.executiveSummary).toEqual(
      expect.objectContaining({
        releaseAction: "BLOCK",
        topRisks: expect.arrayContaining([
          expect.objectContaining({
            severity: "P0",
            code: "TARGET_ROUTE_FORBIDDEN",
            owner: "backend-owner",
            affectedCaseIds: ["case-route"]
          })
        ])
      })
    );
    expect(report.caseImpacts).toContainEqual(
      expect.objectContaining({
        caseId: "case-route",
        scoreDelta: -20,
        evidenceRefs: expect.arrayContaining([
          "candidate:workflow-trace.json#event=event-route"
        ]),
        retestCondition: expect.stringContaining("backend-owner")
      })
    );
    expect(report.statistics).toMatchObject({
      sampleSize: { observed: 20, minimum: 20 },
      missingRate: 0.05,
      variance: expect.arrayContaining([
        { dimension: "routing", variance: 0.12 }
      ]),
      confidenceIntervals: expect.arrayContaining([
        { metric: "pairedScoreDelta", lower: -12, upper: -4 }
      ])
    });
    expect(report.evidenceRefs).toEqual(
      expect.arrayContaining([
        "comparison:comparison-result.json",
        "gate:gate-result.json",
        "candidate:workflow-trace.json#event=event-route",
        "policy:configs/evaluation/gate-policy.json"
      ])
    );

    const markdown = renderDecisionReportMarkdown(report);
    expect(markdown).toContain("Gate Decision: BLOCK");
    expect(markdown).toContain("Retest condition");
    expect(markdown).toContain("candidate:workflow-trace.json#event=event-route");
  });

  test("uses the workflow-owner boundary when comparison evidence has no public role identity", () => {
    const comparison = comparisonResult();
    delete comparison.hardFailures[0].owner;

    const report = buildDecisionReport({
      comparison,
      gate: gateResult()
    });

    expect(report.executiveSummary.topRisks[0]!.owner).toBe(
      "workflow-owner"
    );
    expect(report.recommendations[0]!.owner).toBe("workflow-owner");
    expect(report.caseImpacts[0]!.retestCondition).toContain(
      "workflow-owner"
    );
  });
});

function comparisonResult(): any {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: HASH_A,
      policyHash: HASH_B
    },
    baseline: {
      targetId: "target-a",
      suite: "smoke",
      runId: "baseline",
      releaseDecision: "APPROVE",
      score: 92,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    candidate: {
      targetId: "target-a",
      suite: "smoke",
      runId: "candidate",
      releaseDecision: "BLOCK",
      score: 72,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    comparability: { status: "COMPARABLE", reasons: [] },
    classification: "REGRESSED",
    scoreDelta: -20,
    caseDeltas: [
      {
        caseId: "case-route",
        classification: "REGRESSED",
        baselineVerdict: "PASS",
        candidateVerdict: "FAIL",
        scoreDelta: -20,
        newHardFailures: ["TARGET_ROUTE_FORBIDDEN"],
        resolvedHardFailures: []
      }
    ],
    summary: {
      improved: 0,
      regressed: 1,
      unchanged: 0,
      hardFailure: 1,
      incomparable: 0
    },
    hardFailures: [
      {
        code: "TARGET_ROUTE_FORBIDDEN",
        severity: "P0",
        source: "candidate",
        caseId: "case-route",
        owner: "backend-owner",
        why: "Candidate routed owner-only work to the wrong role.",
        evidenceEventIds: ["event-route"]
      }
    ],
    evidenceRefs: {
      baseline: ["baseline:workflow-trace.json"],
      candidate: ["candidate:workflow-trace.json#event=event-route"]
    },
    integrity: {
      status: "VERIFIED_AT_WRITE",
      comparisonHash: HASH_A,
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
    decision: "BLOCK",
    ruleId: "GATE-HARD-FAILURE",
    targetId: "target-a",
    suite: "smoke",
    comparisonClassification: "REGRESSED",
    comparisonIntegrity: "VALID",
    gatePolicy: {
      policyId: "awb-gate-policy",
      policyVersion: "1.0.0",
      rulesHash: HASH_A,
      policyHash: HASH_B
    },
    reasons: ["candidate:TARGET_ROUTE_FORBIDDEN"],
    evidenceRefs: [
      "comparison:comparison-result.json",
      "policy:configs/evaluation/gate-policy.json",
      "candidate:workflow-trace.json#event=event-route"
    ]
  };
}
