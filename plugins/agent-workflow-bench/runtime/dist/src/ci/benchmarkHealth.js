import path from "node:path";
import { AWB_VERSION, PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";
export function buildBenchmarkHealthReport(input) {
    validateInput(input);
    const reasons = new Set();
    const checks = toChecks(input);
    if (checks.some((check) => check.status === "MISSING")) {
        reasons.add("HEALTH_CHECK_MISSING");
    }
    if (input.goldCorpus.status !== "PASS") {
        reasons.add("HEALTH_GOLD_CORPUS_FAILED");
    }
    if (input.p0Mutation.status !== "PASS") {
        reasons.add("HEALTH_P0_MUTATION_FAILED");
    }
    if (input.goldCorpus.p0MutationKillRate !== 1 ||
        input.goldCorpus.falseNegativeCount > 0 ||
        input.p0Mutation.detectionRate !== 1 ||
        input.p0Mutation.falseNegativeCount > 0) {
        reasons.add("HEALTH_P0_FALSE_NEGATIVE");
    }
    if (input.goldCorpus.falsePassCount > 0 ||
        input.p0Mutation.falsePassCount > 0 ||
        input.observerQualification.falsePassCount > 0 ||
        input.aaReliability.p0FalsePassCount > 0) {
        reasons.add("HEALTH_FALSE_PASS");
    }
    if (input.observerQualification.status !== "PASS" ||
        input.observerQualification.decision !== "valid" ||
        input.observerQualification.p0DetectionRate !== 1 ||
        input.observerQualification.privateKeyVisibleToRunner) {
        reasons.add("HEALTH_OBSERVER_UNQUALIFIED");
    }
    if (input.aaReliability.status !== "PASS" ||
        !["ELIGIBLE", "DIAGNOSTIC_ONLY"].includes(input.aaReliability.gateEligibility) ||
        input.aaReliability.deterministicAgreement !== 1 ||
        input.aaReliability.stableGateAgreement < 0.95 ||
        !input.aaReliability.sampleSufficient) {
        reasons.add("HEALTH_RELIABILITY_FAILED");
    }
    if (input.schemaCompatibility.status !== "PASS" ||
        !input.schemaCompatibility.compatible ||
        input.schemaCompatibility.incompatibleArtifactCount > 0) {
        reasons.add("HEALTH_SCHEMA_INCOMPATIBLE");
    }
    if (input.pluginInstall.status !== "PASS" ||
        !input.pluginInstall.freshInstall ||
        !input.pluginInstall.runtimeParity) {
        reasons.add("HEALTH_PLUGIN_INSTALL_FAILED");
    }
    if (input.privacyScan.status !== "PASS" ||
        input.privacyScan.findingCount > 0) {
        reasons.add("HEALTH_PRIVACY_SCAN_FAILED");
    }
    const reasonCodes = [...reasons];
    const status = reasonCodes.length === 0 ? "HEALTHY" : "DEGRADED";
    const inputHash = sha256Text(stableJson(input));
    const reportWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "benchmark_health_report",
        product: PRODUCT_NAME,
        benchmarkVersion: input.benchmarkVersion,
        generatedAt: input.generatedAt,
        status,
        versionDisposition: status === "HEALTHY"
            ? "RELEASE_ELIGIBLE"
            : "DIAGNOSTIC_ONLY",
        reasonCodes,
        checks,
        inputHash,
        automaticActions: {
            versionDispositionApplied: true,
            trustEnrollment: "disabled",
            workflowModification: "disabled",
            fixPullRequestCreation: "disabled"
        }
    };
    return {
        ...reportWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(reportWithoutIntegrity))
        }
    };
}
export function benchmarkHealthExitCode(report) {
    return report.versionDisposition === "RELEASE_ELIGIBLE" ? 0 : 2;
}
export function assertBenchmarkHealthReportIntegrity(report) {
    const { integrity, ...content } = report;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(content))) {
        throw new Error("Benchmark health report integrity verification failed.");
    }
    const expectedHealthy = report.reasonCodes.length === 0;
    if (report.status !== (expectedHealthy ? "HEALTHY" : "DEGRADED") ||
        report.versionDisposition !==
            (expectedHealthy ? "RELEASE_ELIGIBLE" : "DIAGNOSTIC_ONLY") ||
        report.automaticActions.versionDispositionApplied !== true ||
        report.automaticActions.trustEnrollment !== "disabled" ||
        report.automaticActions.workflowModification !== "disabled" ||
        report.automaticActions.fixPullRequestCreation !== "disabled") {
        throw new Error("Benchmark health disposition is inconsistent with its reasons or safety policy.");
    }
}
function validateInput(input) {
    if (!input ||
        input.benchmarkVersion !== AWB_VERSION ||
        !Number.isFinite(Date.parse(input.generatedAt))) {
        throw new Error(`Benchmark health requires current AWB ${AWB_VERSION} and a valid timestamp.`);
    }
    const evidence = [
        input.goldCorpus,
        input.p0Mutation,
        input.observerQualification,
        input.aaReliability,
        input.schemaCompatibility,
        input.pluginInstall,
        input.privacyScan
    ];
    for (const item of evidence) {
        if (!["PASS", "FAIL", "MISSING"].includes(item.status) ||
            !isPortableEvidenceRef(item.evidenceRef) ||
            !isHash(item.evidenceHash)) {
            throw new Error("Benchmark health checks require a portable evidence ref and SHA-256 evidence hash.");
        }
    }
    for (const rate of [
        input.goldCorpus.p0MutationKillRate,
        input.p0Mutation.detectionRate,
        input.observerQualification.p0DetectionRate,
        input.aaReliability.deterministicAgreement,
        input.aaReliability.stableGateAgreement
    ]) {
        if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
            throw new Error("Benchmark health rates must be within [0, 1].");
        }
    }
    for (const count of [
        input.goldCorpus.falseNegativeCount,
        input.goldCorpus.falsePassCount,
        input.goldCorpus.knownGoodBlockedCount,
        input.p0Mutation.falseNegativeCount,
        input.p0Mutation.falsePassCount,
        input.observerQualification.falsePassCount,
        input.aaReliability.p0FalsePassCount,
        input.schemaCompatibility.incompatibleArtifactCount,
        input.privacyScan.findingCount
    ]) {
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error("Benchmark health counts must be non-negative safe integers.");
        }
    }
}
function toChecks(input) {
    return [
        check("gold_corpus", input.goldCorpus),
        check("p0_mutation", input.p0Mutation),
        check("observer_qualification", input.observerQualification),
        check("aa_reliability", input.aaReliability),
        check("schema_compatibility", input.schemaCompatibility),
        check("plugin_install", input.pluginInstall),
        check("privacy_scan", input.privacyScan)
    ];
}
function check(id, input) {
    return {
        id,
        status: input.status,
        evidenceRef: input.evidenceRef,
        evidenceHash: input.evidenceHash
    };
}
function isPortableEvidenceRef(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        !path.isAbsolute(value) &&
        !value.split(/[\\/]/u).includes("..") &&
        !value.includes("\\"));
}
function isHash(value) {
    return /^sha256:[a-f0-9]{64}$/u.test(value);
}
