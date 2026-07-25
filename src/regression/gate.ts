import { PRODUCT_NAME } from "../core/product.js";
import type { ComparisonContent, ComparisonVerification } from "./compare.js";

export interface GateResult {
  schemaVersion: "0.1.0";
  product: typeof PRODUCT_NAME;
  decision: "PASS" | "DIAGNOSTIC_ONLY" | "BLOCK";
  ruleId:
    | "GATE-HARD-FAILURE"
    | "GATE-COMPARISON-INTEGRITY"
    | "GATE-REGRESSION"
    | "GATE-CANDIDATE-BLOCK"
    | "GATE-INCOMPARABLE"
    | "GATE-EVIDENCE-NOT-WORKFLOW-TRACE"
    | "GATE-CANDIDATE-DIAGNOSTIC"
    | "GATE-CANDIDATE-BELOW-PASS"
    | "GATE-PASS";
  targetId: string;
  suite: string;
  comparisonClassification: ComparisonContent["classification"];
  comparisonIntegrity: ComparisonVerification["status"];
  reasons: string[];
  evidenceRefs: string[];
}

export function evaluateGate(comparison: ComparisonContent, verification: ComparisonVerification): GateResult {
  const base: Omit<GateResult, "decision" | "ruleId" | "reasons"> = {
    schemaVersion: "0.1.0" as const,
    product: PRODUCT_NAME,
    targetId: comparison.candidate.targetId,
    suite: comparison.candidate.suite,
    comparisonClassification: comparison.classification,
    comparisonIntegrity: verification.status,
    evidenceRefs: [
      "comparison:comparison-result.json",
      ...comparison.evidenceRefs.baseline,
      ...comparison.evidenceRefs.candidate
    ]
  };

  if (verification.status !== "VALID") {
    return {
      ...base,
      decision: "BLOCK",
      ruleId: "GATE-COMPARISON-INTEGRITY",
      reasons:
        verification.reasons.length > 0
          ? verification.reasons
          : ["The comparison artifact could not be tied to validated baseline/candidate evidence."]
    };
  }
  if (comparison.classification === "HARD_FAILURE" || comparison.hardFailures.length > 0) {
    return {
      ...base,
      decision: "BLOCK",
      ruleId: "GATE-HARD-FAILURE",
      reasons: comparison.hardFailures.map((failure) => `${failure.source}:${failure.code} - ${failure.why}`)
    };
  }
  if (comparison.classification === "REGRESSED" || comparison.classification === "MIXED") {
    return {
      ...base,
      decision: "BLOCK",
      ruleId: "GATE-REGRESSION",
      reasons: [`Candidate comparison classified as ${comparison.classification}.`]
    };
  }
  if (comparison.candidate.releaseDecision === "BLOCK") {
    return {
      ...base,
      decision: "BLOCK",
      ruleId: "GATE-CANDIDATE-BLOCK",
      reasons: ["The candidate single-run evidence decision is BLOCK."]
    };
  }
  if (comparison.comparability.status !== "COMPARABLE" || comparison.classification === "INCOMPARABLE") {
    return {
      ...base,
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-INCOMPARABLE",
      reasons:
        comparison.comparability.reasons.length > 0
          ? comparison.comparability.reasons
          : ["Baseline and candidate evidence are not comparable."]
    };
  }
  if (
    comparison.baseline.provenanceStatus !== "VALID" ||
    comparison.candidate.provenanceStatus !== "VALID" ||
    comparison.baseline.evidenceKind !== "live" ||
    comparison.candidate.evidenceKind !== "live" ||
    comparison.baseline.observationLevel !== "workflow_trace" ||
    comparison.candidate.observationLevel !== "workflow_trace"
  ) {
    return {
      ...base,
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-EVIDENCE-NOT-WORKFLOW-TRACE",
      reasons: [
        `Baseline evidence: ${comparison.baseline.provenanceStatus}/${comparison.baseline.evidenceKind}/${comparison.baseline.observationLevel}.`,
        `Candidate evidence: ${comparison.candidate.provenanceStatus}/${comparison.candidate.evidenceKind}/${comparison.candidate.observationLevel}.`
      ]
    };
  }
  if (comparison.candidate.releaseDecision === "DIAGNOSTIC_ONLY") {
    return {
      ...base,
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "GATE-CANDIDATE-DIAGNOSTIC",
      reasons: ["The candidate single-run evidence remains DIAGNOSTIC_ONLY."]
    };
  }
  if (comparison.candidate.releaseDecision === "CONDITIONAL_APPROVE") {
    return {
      ...base,
      decision: "BLOCK",
      ruleId: "GATE-CANDIDATE-BELOW-PASS",
      reasons: ["The candidate did not meet the existing APPROVE threshold."]
    };
  }
  return {
    ...base,
    decision: "PASS",
    ruleId: "GATE-PASS",
    reasons: [
      `Matched live workflow-trace evidence classified the candidate as ${comparison.classification} with no blocking failure.`
    ]
  };
}

export function gateExitCode(decision: GateResult["decision"]): 0 | 1 | 2 {
  if (decision === "PASS") {
    return 0;
  }
  return decision === "BLOCK" ? 1 : 2;
}

export function renderGateReport(result: GateResult): string {
  return [
    `# ${PRODUCT_NAME} Gate`,
    "",
    `Target: ${result.targetId}`,
    `Suite: ${result.suite}`,
    `Decision: ${result.decision}`,
    `Rule: ${result.ruleId}`,
    `Comparison: ${result.comparisonClassification}`,
    `Comparison integrity: ${result.comparisonIntegrity}`,
    "",
    "## Reasons",
    ...result.reasons.map((reason) => `- ${reason}`),
    "",
    "## Evidence",
    ...result.evidenceRefs.map((ref) => `- ${ref}`)
  ].join("\n");
}
