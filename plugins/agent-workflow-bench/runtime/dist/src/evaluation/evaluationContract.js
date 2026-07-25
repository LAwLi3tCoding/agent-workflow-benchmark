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
