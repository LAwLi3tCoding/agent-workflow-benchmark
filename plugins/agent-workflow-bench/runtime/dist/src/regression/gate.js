import { PRODUCT_NAME } from "../core/product.js";
import { compareGatePolicyBindings, gatePolicyBinding, loadCanonicalGatePolicy } from "../calibration/policyArtifact.js";
export function evaluateGate(comparison, verification, policy = loadCanonicalGatePolicy(), policyEvidenceRef = "configs/evaluation/gate-policy.json") {
    const policyBinding = gatePolicyBinding(policy);
    const base = {
        schemaVersion: "0.1.0",
        product: PRODUCT_NAME,
        targetId: comparison.candidate.targetId,
        suite: comparison.candidate.suite,
        comparisonClassification: comparison.classification,
        comparisonIntegrity: verification.status,
        gatePolicy: policyBinding,
        evidenceRefs: [
            "comparison:comparison-result.json",
            `policy:${policyEvidenceRef}`,
            ...comparison.evidenceRefs.baseline,
            ...comparison.evidenceRefs.candidate
        ]
    };
    if (verification.status !== "VALID") {
        return {
            ...base,
            decision: "BLOCK",
            ruleId: "GATE-COMPARISON-INTEGRITY",
            reasons: verification.reasons.length > 0
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
    const policyCompatibility = compareGatePolicyBindings(comparison.gatePolicy, policyBinding);
    if (policyCompatibility.status === "INCOMPARABLE") {
        return {
            ...base,
            decision: "DIAGNOSTIC_ONLY",
            ruleId: "GATE-POLICY-INCOMPARABLE",
            reasons: [
                `Comparison policy is not recomputable under the selected gate policy: ${policyCompatibility.reasonCode}.`
            ]
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
            reasons: comparison.comparability.reasons.length > 0
                ? comparison.comparability.reasons
                : ["Baseline and candidate evidence are not comparable."]
        };
    }
    if (comparison.baseline.provenanceStatus !== "VALID" ||
        comparison.candidate.provenanceStatus !== "VALID" ||
        comparison.baseline.evidenceKind !== "live" ||
        comparison.candidate.evidenceKind !== "live" ||
        comparison.baseline.observationLevel !== "workflow_trace" ||
        comparison.candidate.observationLevel !== "workflow_trace") {
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
    if (comparison.baseline.observerQualificationStatus !== "valid" ||
        comparison.candidate.observerQualificationStatus !== "valid") {
        return {
            ...base,
            decision: "DIAGNOSTIC_ONLY",
            ruleId: "GATE-OBSERVER-UNQUALIFIED",
            reasons: [
                `Baseline observer qualification: ${comparison.baseline.observerQualificationStatus}.`,
                `Candidate observer qualification: ${comparison.candidate.observerQualificationStatus}.`
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
export function gateExitCode(decision) {
    if (decision === "PASS") {
        return 0;
    }
    return decision === "BLOCK" ? 1 : 2;
}
export function renderGateReport(result) {
    return [
        `# ${PRODUCT_NAME} Gate`,
        "",
        `Target: ${result.targetId}`,
        `Suite: ${result.suite}`,
        `Decision: ${result.decision}`,
        `Rule: ${result.ruleId}`,
        `Comparison: ${result.comparisonClassification}`,
        `Comparison integrity: ${result.comparisonIntegrity}`,
        `Gate policy: ${result.gatePolicy.policyVersion} (${result.gatePolicy.policyHash})`,
        "",
        "## Reasons",
        ...result.reasons.map((reason) => `- ${reason}`),
        "",
        "## Evidence",
        ...result.evidenceRefs.map((ref) => `- ${ref}`)
    ].join("\n");
}
