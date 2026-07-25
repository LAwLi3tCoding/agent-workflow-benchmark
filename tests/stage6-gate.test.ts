import { describe, expect, test } from "vitest";
import {
  gatePolicyBinding,
  loadCanonicalGatePolicy
} from "../src/calibration/gatePolicy.js";
import type { ComparisonContent } from "../src/regression/compare.js";
import { evaluateGate } from "../src/regression/gate.js";

function qualifiedComparison(): ComparisonContent {
  const policy = loadCanonicalGatePolicy();
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    gatePolicy: gatePolicyBinding(policy),
    baseline: {
      targetId: "fixture-target",
      suite: "smoke",
      runId: "baseline",
      releaseDecision: "APPROVE",
      score: 90,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    candidate: {
      targetId: "fixture-target",
      suite: "smoke",
      runId: "candidate",
      releaseDecision: "APPROVE",
      score: 91,
      provenanceStatus: "VALID",
      evidenceKind: "live",
      observationLevel: "workflow_trace",
      observerQualificationStatus: "valid"
    },
    comparability: { status: "COMPARABLE", reasons: [] },
    classification: "IMPROVED",
    scoreDelta: 1,
    caseDeltas: [],
    summary: {
      improved: 1,
      regressed: 0,
      unchanged: 0,
      hardFailure: 0,
      incomparable: 0
    },
    hardFailures: [],
    evidenceRefs: {
      baseline: ["baseline:suite-result.json"],
      candidate: ["candidate:suite-result.json"]
    }
  };
}

describe("Stage 6 gate-policy binding", () => {
  test("records the exact calibrated policy used for a qualified PASS", () => {
    const policy = loadCanonicalGatePolicy();
    const result = evaluateGate(
      qualifiedComparison(),
      { status: "VALID", reasons: [] },
      policy
    );

    expect(result.decision).toBe("PASS");
    expect(result.ruleId).toBe("GATE-PASS");
    expect(result.gatePolicy).toEqual(gatePolicyBinding(policy));
    expect(result.evidenceRefs).toContain("policy:configs/evaluation/gate-policy.json");
  });

  test("keeps a legacy or mismatched policy comparison explicitly incomparable", () => {
    const policy = loadCanonicalGatePolicy();
    const legacy = qualifiedComparison();
    delete legacy.gatePolicy;

    expect(
      evaluateGate(legacy, { status: "VALID", reasons: [] }, policy)
    ).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-POLICY-INCOMPARABLE"
    });

    const mismatched = qualifiedComparison();
    mismatched.gatePolicy = {
      ...gatePolicyBinding(policy),
      policyHash: `sha256:${"0".repeat(64)}`
    };
    expect(
      evaluateGate(mismatched, { status: "VALID", reasons: [] }, policy)
    ).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-POLICY-INCOMPARABLE"
    });
  });

  test("hard failure dominance cannot be overridden by policy incompatibility", () => {
    const policy = loadCanonicalGatePolicy();
    const comparison = qualifiedComparison();
    comparison.gatePolicy = {
      ...gatePolicyBinding(policy),
      policyHash: `sha256:${"0".repeat(64)}`
    };
    comparison.classification = "HARD_FAILURE";
    comparison.hardFailures = [
      {
        code: "GATE_FALSE_PASS",
        severity: "P0",
        source: "candidate",
        why: "A skipped gate was represented as PASS."
      }
    ];

    expect(
      evaluateGate(comparison, { status: "VALID", reasons: [] }, policy)
    ).toMatchObject({
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE"
    });
  });
});
