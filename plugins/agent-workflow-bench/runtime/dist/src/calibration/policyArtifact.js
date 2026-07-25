import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRODUCT_NAME } from "../core/product.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { getEvaluationContract } from "../evaluation/evaluationContract.js";
import { sha256Text, stableJson } from "../utils/hash.js";
export const DEFAULT_GATE_POLICY_PATH = path.join(getBenchmarkRoot(), "configs/evaluation/gate-policy.json");
export function gatePolicyBinding(policy) {
    assertGatePolicy(policy);
    return {
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        rulesHash: policy.rulesHash,
        policyHash: policy.policyHash
    };
}
export function compareGatePolicyBindings(left, right) {
    if (!left || !right) {
        return { status: "INCOMPARABLE", reasonCode: "GATE_POLICY_MISSING" };
    }
    if (left.policyVersion !== right.policyVersion) {
        return {
            status: "INCOMPARABLE",
            reasonCode: "GATE_POLICY_VERSION_MISMATCH"
        };
    }
    if (left.rulesHash !== right.rulesHash) {
        return {
            status: "INCOMPARABLE",
            reasonCode: "GATE_POLICY_RULES_MISMATCH"
        };
    }
    if (left.policyHash !== right.policyHash) {
        return {
            status: "INCOMPARABLE",
            reasonCode: "GATE_POLICY_HASH_MISMATCH"
        };
    }
    return { status: "RECOMPUTABLE" };
}
export function reviseGatePolicy(policy, revision) {
    assertGatePolicy(policy);
    const revised = createGatePolicy({
        policyVersion: revision.policyVersion,
        rules: revision.rules,
        derivedFrom: revision.derivedFrom ?? policy.derivedFrom
    });
    if (policy.policyVersion === revised.policyVersion &&
        policy.rulesHash !== revised.rulesHash) {
        throw new Error(`Gate policy ${policy.policyVersion} cannot change rules without a policyVersion bump.`);
    }
    return revised;
}
export function loadCanonicalGatePolicy() {
    return loadGatePolicy(DEFAULT_GATE_POLICY_PATH);
}
export function loadGatePolicy(policyPath) {
    if (!existsSync(policyPath)) {
        throw new Error(`Gate policy is missing: ${path.relative(getBenchmarkRoot(), policyPath)}.`);
    }
    const parsed = JSON.parse(readFileSync(policyPath, "utf8"));
    assertGatePolicy(parsed);
    return parsed;
}
export function createGatePolicy(options) {
    assertPolicyVersion(options.policyVersion);
    assertGatePolicyRules(options.rules);
    assertDerivedFrom(options.derivedFrom);
    const rules = normalizeRules(options.rules);
    const rulesHash = sha256Text(stableJson(rules));
    const content = {
        schemaVersion: "0.1.0",
        artifactType: "gate_policy",
        product: PRODUCT_NAME,
        policyId: "awb-gate-policy",
        policyVersion: options.policyVersion,
        rulesHash,
        status: "CALIBRATED",
        hardFailurePrecedence: true,
        derivedFrom: normalizeDerivedFrom(options.derivedFrom),
        rules
    };
    const integrity = {
        status: "VERIFIED_AT_WRITE",
        contentHash: sha256Text(stableJson(content))
    };
    return {
        ...content,
        policyHash: sha256Text(stableJson({ ...content, integrity })),
        integrity
    };
}
export function baselineGatePolicyRules() {
    const contract = getEvaluationContract();
    const score = contract.scorePolicy;
    return normalizeRules({
        dimensionWeights: Object.fromEntries(contract.dimensions
            .filter((dimension) => dimension.status === "implemented")
            .map((dimension) => [dimension.id, dimension.weight])
            .sort(([left], [right]) => left.localeCompare(right))),
        score: {
            casePassMinimum: score.casePassMinimum,
            caseConditionalMinimum: score.caseConditionalMinimum,
            suiteApproveMinimum: score.suiteApproveMinimum,
            suiteConditionalMinimum: score.suiteConditionalMinimum,
            p0ScoreCap: score.p0ScoreCap,
            p1ScoreCap: score.p1ScoreCap
        },
        telemetry: {
            minimumCompleteness: score.telemetryMinimum,
            truePassRequires: { ...contract.evidencePolicy.truePassRequires },
            diagnosticOnlyObservationLevels: [
                ...contract.evidencePolicy.diagnosticOnlyObservationLevels
            ].sort(),
            blockingFailureCodes: contract.hardFailures
                .filter((failure) => failure.status === "implemented" && failure.severity === "P0")
                .map((failure) => failure.code)
                .sort()
        },
        budget: {
            maximumTokenBudgetRatio: 1,
            maximumWallClockBudgetRatio: 1,
            wastedRatioWarning: score.efficiencyWastedRatioWarning,
            exhaustionFailureCodes: ["TOKEN_LEDGER_MISSING"].sort()
        },
        classification: {
            minimumMeaningfulScoreDelta: 1
        }
    });
}
function assertGatePolicy(policy) {
    if (policy.schemaVersion !== "0.1.0" ||
        policy.artifactType !== "gate_policy" ||
        policy.product !== PRODUCT_NAME ||
        policy.policyId !== "awb-gate-policy" ||
        policy.status !== "CALIBRATED" ||
        policy.hardFailurePrecedence !== true ||
        policy.integrity?.status !== "VERIFIED_AT_WRITE") {
        throw new Error("Gate policy artifact is missing or unsupported.");
    }
    const expected = createGatePolicy({
        policyVersion: policy.policyVersion,
        rules: policy.rules,
        derivedFrom: policy.derivedFrom
    });
    if (policy.rulesHash !== expected.rulesHash ||
        policy.policyHash !== expected.policyHash ||
        policy.integrity.contentHash !== expected.integrity.contentHash) {
        throw new Error("Gate policy hash does not match its canonical content.");
    }
}
function assertGatePolicyRules(rules) {
    const contract = getEvaluationContract();
    const implementedDimensions = contract.dimensions
        .filter((dimension) => dimension.status === "implemented")
        .map((dimension) => dimension.id)
        .sort();
    const ruleDimensions = Object.keys(rules.dimensionWeights).sort();
    if (stableJson(ruleDimensions) !== stableJson(implementedDimensions)) {
        throw new Error("Gate policy dimension weights must match implemented dimensions.");
    }
    for (const value of Object.values(rules.dimensionWeights)) {
        assertPositive(value, "dimension weight");
    }
    for (const [key, value] of Object.entries(rules.score)) {
        assertScore(value, `score threshold ${key}`);
    }
    if (rules.score.casePassMinimum < contract.scorePolicy.casePassMinimum ||
        rules.score.caseConditionalMinimum <
            contract.scorePolicy.caseConditionalMinimum ||
        rules.score.suiteApproveMinimum < contract.scorePolicy.suiteApproveMinimum ||
        rules.score.suiteConditionalMinimum <
            contract.scorePolicy.suiteConditionalMinimum ||
        rules.score.p0ScoreCap > contract.scorePolicy.p0ScoreCap ||
        rules.score.p1ScoreCap > contract.scorePolicy.p1ScoreCap ||
        rules.score.casePassMinimum < rules.score.caseConditionalMinimum ||
        rules.score.suiteApproveMinimum < rules.score.suiteConditionalMinimum ||
        rules.score.p0ScoreCap > rules.score.p1ScoreCap ||
        rules.score.p1ScoreCap >= rules.score.casePassMinimum) {
        throw new Error("Gate policy score thresholds weaken or disorder the canonical contract.");
    }
    if (rules.telemetry.minimumCompleteness < contract.scorePolicy.telemetryMinimum) {
        throw new Error("Gate policy telemetry threshold weakens the canonical contract.");
    }
    assertRatio(rules.telemetry.minimumCompleteness, "telemetry minimum");
    if (rules.telemetry.truePassRequires.evidenceKind !== "live" ||
        rules.telemetry.truePassRequires.observationLevel !== "workflow_trace" ||
        rules.telemetry.truePassRequires.observerQualification !== "valid") {
        throw new Error("Gate policy true-pass evidence requirements must remain canonical.");
    }
    if (rules.budget.maximumTokenBudgetRatio !== 1) {
        throw new Error("Gate policy maximumTokenBudgetRatio must remain 1.");
    }
    if (rules.budget.maximumWallClockBudgetRatio !== 1) {
        throw new Error("Gate policy maximumWallClockBudgetRatio must remain 1.");
    }
    assertRatio(rules.budget.wastedRatioWarning, "wasted-token warning");
    if (rules.budget.wastedRatioWarning > contract.scorePolicy.efficiencyWastedRatioWarning) {
        throw new Error("Gate policy wasted-ratio warning weakens the canonical contract.");
    }
    assertContainsAll(rules.budget.exhaustionFailureCodes, ["TOKEN_LEDGER_MISSING"], "budget exhaustion failure codes");
    assertContainsAll(rules.telemetry.diagnosticOnlyObservationLevels, contract.evidencePolicy.diagnosticOnlyObservationLevels, "diagnostic-only observation levels");
    assertContainsAll(rules.telemetry.blockingFailureCodes, contract.hardFailures
        .filter((failure) => failure.status === "implemented" && failure.severity === "P0")
        .map((failure) => failure.code), "P0 blocking failure codes");
    assertPositive(rules.classification.minimumMeaningfulScoreDelta, "classification minimum meaningful score delta");
    if (rules.classification.minimumMeaningfulScoreDelta > 1) {
        throw new Error("Gate policy classification delta weakens the canonical baseline.");
    }
}
function normalizeRules(rules) {
    return {
        dimensionWeights: Object.fromEntries(Object.entries(rules.dimensionWeights).sort(([left], [right]) => left.localeCompare(right))),
        score: { ...rules.score },
        telemetry: {
            minimumCompleteness: rules.telemetry.minimumCompleteness,
            truePassRequires: { ...rules.telemetry.truePassRequires },
            diagnosticOnlyObservationLevels: [
                ...rules.telemetry.diagnosticOnlyObservationLevels
            ].sort(),
            blockingFailureCodes: [...rules.telemetry.blockingFailureCodes].sort()
        },
        budget: {
            maximumTokenBudgetRatio: 1,
            maximumWallClockBudgetRatio: 1,
            wastedRatioWarning: rules.budget.wastedRatioWarning,
            exhaustionFailureCodes: [...rules.budget.exhaustionFailureCodes].sort()
        },
        classification: { ...rules.classification }
    };
}
function assertDerivedFrom(derivedFrom) {
    assertHash(derivedFrom.goldCorpus.corpusHash, "corpusHash");
    assertHash(derivedFrom.goldCorpus.labelsHash, "labelsHash");
    assertHash(derivedFrom.goldCorpus.trajectoriesHash, "trajectoriesHash");
    assertHash(derivedFrom.splitHashes.development, "development split hash");
    assertHash(derivedFrom.splitHashes.calibration, "calibration split hash");
    assertHash(derivedFrom.sampleHash, "sampleHash");
    if (derivedFrom.fitSplits[0] !== "development" ||
        derivedFrom.fitSplits[1] !== "calibration" ||
        derivedFrom.sampleCount < 1) {
        throw new Error("Gate policy derivedFrom is invalid.");
    }
}
function normalizeDerivedFrom(derivedFrom) {
    return {
        goldCorpus: { ...derivedFrom.goldCorpus },
        fitSplits: ["development", "calibration"],
        splitHashes: { ...derivedFrom.splitHashes },
        sampleCount: derivedFrom.sampleCount,
        sampleHash: derivedFrom.sampleHash
    };
}
function assertPolicyVersion(policyVersion) {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(policyVersion)) {
        throw new Error("Gate policyVersion must be a semantic version.");
    }
}
function assertHash(value, label) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
        throw new Error(`Gate policy ${label} must be a sha256 hash.`);
    }
}
function assertPositive(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`Gate policy ${label} must be positive.`);
    }
}
function assertRatio(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Gate policy ${label} must be a ratio.`);
    }
}
function assertScore(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`Gate policy ${label} must be a score.`);
    }
}
function assertContainsAll(actual, required, label) {
    const actualSet = new Set(actual);
    const missing = required.filter((item) => !actualSet.has(item));
    if (missing.length > 0) {
        throw new Error(`Gate policy ${label} omitted canonical entries: ${missing.join(", ")}.`);
    }
}
