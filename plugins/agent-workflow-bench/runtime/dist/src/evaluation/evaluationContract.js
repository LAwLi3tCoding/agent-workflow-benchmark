import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
let cachedContract;
export function getEvaluationContract() {
    if (!cachedContract) {
        const configPath = path.join(getBenchmarkRoot(), "configs/evaluation/evaluation-contract.yaml");
        cachedContract = YAML.parse(readFileSync(configPath, "utf8"));
        assertEvaluationContract(cachedContract);
    }
    return cachedContract;
}
export function getImplementedEventIds() {
    return implementedIds(getEvaluationContract().events);
}
export function getImplementedCoverageTargets() {
    return getEvaluationContract().coverageTargets.filter((item) => item.status === "implemented");
}
export function getImplementedOracles() {
    return getEvaluationContract().oracles.filter((item) => item.status === "implemented");
}
export function getImplementedDimensions() {
    return getEvaluationContract().dimensions.filter((item) => item.status === "implemented");
}
export function getScorePolicy() {
    return getEvaluationContract().scorePolicy;
}
export function getReliabilityPolicy() {
    return getEvaluationContract().reliabilityPolicy;
}
export function getCriterionValidityPolicy() {
    return getEvaluationContract().criterionValidityPolicy;
}
export function getGatePolicyContract() {
    return getEvaluationContract().gatePolicy;
}
export function getHardFailureDefinition(code) {
    return getEvaluationContract().hardFailures.find((item) => item.code === code && item.status === "implemented");
}
export function getImplementedHardFailureCodes(severity) {
    return getEvaluationContract().hardFailures
        .filter((item) => item.status === "implemented" &&
        (severity === undefined || item.severity === severity))
        .map((item) => item.code);
}
function implementedIds(items) {
    return items.filter((item) => item.status === "implemented").map((item) => item.id);
}
function assertEvaluationContract(contract) {
    if (!contract ||
        contract.schemaVersion !== "0.1.0" ||
        contract.contractId !== "agent-workflow-bench-evaluation-contract") {
        throw new Error("Canonical evaluation contract is missing or unsupported.");
    }
    const reliability = contract.reliabilityPolicy;
    if (!reliability ||
        reliability.deterministicMinimumSamples !== 5 ||
        reliability.liveMinimumSamples !== 20 ||
        reliability.gateConsistencyMinimum !== 0.95 ||
        reliability.caseConsistencyMinimum !== 0.95 ||
        reliability.maximumMissingRate !== 0 ||
        reliability.minimumTelemetryCompleteness !== 0.75 ||
        reliability.confidenceLevel !== 0.95 ||
        reliability.bootstrapIterations !== 2000 ||
        reliability.defaultSeed !== "awb-default-seed-v1") {
        throw new Error("Canonical evaluation contract reliability policy is invalid or weakens frozen thresholds.");
    }
    const criterion = contract.criterionValidityPolicy;
    if (!criterion ||
        JSON.stringify(criterion.requiredTargetClasses) !==
            JSON.stringify(["directory", "cli", "hybrid"]) ||
        JSON.stringify(criterion.requiredRunners) !==
            JSON.stringify(["codex", "claude"]) ||
        JSON.stringify(criterion.requiredDesignStrata) !==
            JSON.stringify([
                "known_improvement",
                "no_change",
                "ordinary_regression",
                "p0_regression"
            ]) ||
        criterion.minimumItemsPerCell !== 5 ||
        criterion.minimumTotalItems !== 120 ||
        criterion.minimumIndependentRaters !== 2 ||
        criterion.p0RecallMinimum !== 1 ||
        criterion.maximumFalsePassCount !== 0 ||
        criterion.overallAgreementMinimum !== 0.85 ||
        criterion.cohenKappaMinimum !== 0.8) {
        throw new Error("Canonical evaluation contract criterion validity policy is invalid or weakens frozen thresholds.");
    }
    const gatePolicy = contract.gatePolicy;
    if (!gatePolicy ||
        gatePolicy.policyId !== "awb-gate-policy" ||
        gatePolicy.canonicalRef !== "configs/evaluation/gate-policy.json" ||
        gatePolicy.schemaRef !== "schemas/gate-policy.schema.json" ||
        gatePolicy.calibrationReportSchemaRef !==
            "schemas/calibration-report.schema.json" ||
        JSON.stringify(gatePolicy.fitSplits) !==
            JSON.stringify(["development", "calibration"]) ||
        gatePolicy.holdoutSplit !== "holdout" ||
        gatePolicy.publicFixtureReleaseEligible !== false) {
        throw new Error("Canonical evaluation contract gate-policy boundary is missing or unsafe.");
    }
    for (const [label, ids] of [
        ["event", contract.events.map((item) => item.id)],
        ["oracle", contract.oracles.map((item) => item.id)],
        ["hard failure", contract.hardFailures.map((item) => item.code)],
        ["dimension", contract.dimensions.map((item) => item.id)],
        ["comparison", contract.comparisonClassifications.map((item) => item.id)],
        ["gate rule", contract.gateRules.map((item) => item.id)],
        ["claim", contract.claims.map((item) => item.id)]
    ]) {
        if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
            throw new Error(`Canonical evaluation contract contains duplicate or empty ${label} ids.`);
        }
    }
}
