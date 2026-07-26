import { PRODUCT_NAME } from "../core/product.js";
import { statusMappingDiagnostics } from "../evaluation/statusSemantics.js";
export function diagnoseWorkflow(profile, capability) {
    const boundary = evidenceBoundary(capability);
    const targetStatus = profile.evidence.missingFiles.length === 0 ? "PASS" : "FAIL";
    const contractReady = profile.contract.roles.length > 0 && profile.contract.entrypoints.length > 0;
    const contractDiagnostics = statusMappingDiagnostics(profile.contract);
    const hasContractMappingGap = contractDiagnostics.length > 0;
    const checks = [
        {
            id: "target-files",
            status: targetStatus,
            why: targetStatus === "PASS"
                ? "Every declared role and file entrypoint was found."
                : `${profile.evidence.missingFiles.length} declared target file(s) are missing.`
        },
        {
            id: "contract-profile",
            status: !contractReady
                ? "FAIL"
                : hasContractMappingGap
                    ? "WARN"
                    : "PASS",
            why: !contractReady
                ? "The ContractModel must include at least one role and one entrypoint."
                : hasContractMappingGap
                    ? `CONTRACT_MAPPING_MISSING: owner-reviewed status semantics are missing for ${contractDiagnostics[0].statusCodes.join(", ")}.`
                    : "The target produced a ContractModel with roles, entrypoints, and owner-reviewed status semantics."
        },
        {
            id: "runner-capability",
            status: capability.supported ? "PASS" : "FAIL",
            why: capability.supported ? `${capability.name} capability detection succeeded.` : capability.disabledReason ?? "Runner is unavailable."
        },
        {
            id: "evidence-boundary",
            status: boundary.observationLevel === "workflow_trace" ? "PASS" : "WARN",
            why: boundary.observationLevel === "workflow_trace"
                ? "The adapter emits live workflow trace evidence."
                : `${capability.name} currently provides ${boundary.observationLevel} evidence, which cannot authorize a real-effect PASS.`
        }
    ];
    const readiness = targetStatus === "FAIL" || !contractReady || !capability.supported
        ? "BLOCK"
        : hasContractMappingGap ||
            boundary.observationLevel !== "workflow_trace"
            ? "DIAGNOSTIC_ONLY"
            : "PASS";
    return {
        schemaVersion: "0.1.0",
        product: PRODUCT_NAME,
        target: {
            id: profile.contract.targetId,
            status: targetStatus,
            contractHash: profile.contract.contractHash,
            roleCount: profile.contract.roles.length,
            entrypointCount: profile.contract.entrypoints.length,
            missingFiles: profile.evidence.missingFiles,
            warnings: profile.evidence.warnings
        },
        runner: {
            name: capability.name,
            supported: capability.supported,
            ...(capability.version ? { version: capability.version } : {}),
            adapterVersion: capability.adapterVersion,
            capabilitiesHash: capability.capabilitiesHash,
            ...boundary
        },
        readiness,
        checks
    };
}
export function evidenceBoundary(capability) {
    if (capability.name === "simulated") {
        return { evidenceKind: "simulated", observationLevel: "synthetic_events" };
    }
    if (!capability.supported || capability.name === "opencode") {
        return { evidenceKind: "unknown", observationLevel: "capability_only" };
    }
    return { evidenceKind: "live", observationLevel: "contract_summary" };
}
export function renderDoctorReport(result) {
    return [
        `# ${PRODUCT_NAME} Doctor`,
        "",
        `Target: ${result.target.id}`,
        `Runner: ${result.runner.name}`,
        `Readiness: ${result.readiness}`,
        `Evidence: ${result.runner.evidenceKind} / ${result.runner.observationLevel}`,
        "",
        "## Checks",
        ...result.checks.map((check) => `- ${check.id}: ${check.status} - ${check.why}`),
        "",
        "## Boundary",
        result.readiness === "PASS"
            ? "The selected adapter can provide release-grade workflow trace evidence."
            : "This diagnosis is useful for discovery, but its evidence boundary does not authorize a real-effect PASS."
    ].join("\n");
}
