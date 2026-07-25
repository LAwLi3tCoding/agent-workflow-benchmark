import { PRODUCT_NAME } from "../core/product.js";
export function renderMarkdownReport(result) {
    const failed = result.caseResults.filter((item) => item.verdict === "FAIL");
    const p0Cases = result.p0CaseRecords;
    const lines = [
        `# ${PRODUCT_NAME} Report`,
        ``,
        `Target: ${result.targetId}`,
        `Suite: ${result.suite}`,
        `Run: ${result.runId}`,
        `Benchmark Evidence Decision: ${result.releaseDecision}`,
        `Decision Scope: collected benchmark evidence only; not release approval unless real workflow trace events are emitted.`,
        `Score: ${result.cappedSuiteScore}`,
        `Telemetry Completeness: ${result.telemetryCompleteness}`,
        ``,
        `## Executive Summary`,
        `- Benchmark Evidence Decision: ${result.releaseDecision}`,
        `- Decision Scope: collected benchmark evidence only; not release approval unless real workflow trace events are emitted.`,
        `- Raw Score: ${result.rawSuiteScore}`,
        `- Capped Score: ${result.cappedSuiteScore}`,
        `- P0 Cases: ${p0Cases.length}`,
        `- Recommendations: ${result.recommendations.length}`,
        ``,
        `## Top Risks`,
        failed.length === 0
            ? `No blocking hard failures were observed.`
            : failed.map((item) => `- ${item.caseId}: ${item.hardFailures.map((failure) => `${failure.severity}:${failure.code}`).join(", ")}`).join("\n"),
        ``,
        `## Dimension Scores`,
        result.dimensionScores.length === 0
            ? `No dimension scores were recorded.`
            : result.dimensionScores
                .map((item) => `- ${item.dimension}: ${item.status} (${item.score}/${item.maxPoints})${item.affectedCaseIds.length > 0 ? `; cases=${item.affectedCaseIds.join(", ")}` : ""}`)
                .join("\n"),
        ``,
        `## Agent Modification Recommendations`,
        result.recommendations.length === 0
            ? `No agent workflow changes are recommended from this run.`
            : result.recommendations
                .map((item) => `- [${item.priority}] ${item.summary} (${item.category})\n  Suggested change: ${item.suggestedChange}\n  Evidence cases: ${item.evidenceCaseIds.join(", ")}`)
                .join("\n"),
        ``,
        `## Harness Validation`,
        renderHarnessValidation(result),
        ``,
        `## P0 Case Records`,
        p0Cases.length === 0
            ? `No P0 cases were recorded.`
            : p0Cases.map((item) => `- ${item.caseId}: ${item.failureCode} - ${item.recommendedAction}`).join("\n"),
        ``,
        `## Case Results`,
        ...result.caseResults.map((item) => `- ${item.caseId}: ${item.verdict} (${item.cappedScore})`),
        ``,
        `## debugHealth`,
        `Status: ${result.debugHealth.status}`,
        `Mutation Kill Rate: ${result.debugHealth.mutationKillRate ?? "not-run"}`,
        `Does Not Affect Target Score: ${result.debugHealth.doesNotAffectTargetScore}`
    ];
    return `${lines.join("\n")}\n`;
}
function renderHarnessValidation(result) {
    const validation = result.harnessValidation;
    if (!validation) {
        return "Harness validation was not attached to this suite result.";
    }
    return [
        `Status: ${validation.status}`,
        `Plan: ${validation.plan.status}; covered ${validation.plan.coveredCoverageTargetCount}/${validation.plan.coverageTargetCount}; missing=${validation.plan.missingCoverageTargetCount}; unknownTags=${validation.plan.unknownCoverageTagCount}; invalidBindings=${validation.plan.invalidBindingCount}`,
        validation.plan.warnings.length === 0 ? `Warnings: none` : `Warnings: ${validation.plan.warnings.join("; ")}`,
        ...validation.phases.map((phase) => `- ${phase.phase}: ${phase.status} - ${phase.why}`)
    ].join("\n");
}
