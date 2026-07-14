const hardFailureWhy = {
    TARGET_ROUTE_FORBIDDEN: "Workflow violated a forbidden routing contract.",
    TARGET_OWNER_BYPASS: "Workflow bypassed a declared owner.",
    GATE_FALSE_PASS: "Workflow represented a skipped/advisory gate as PASS.",
    ARTIFACT_PATH_DRIFT: "Workflow wrote a required artifact to a wrong path.",
    TARGET_JOIN_MISSING: "Workflow missed a required join callback.",
    PRODUCTION_SIDE_EFFECT: "Workflow attempted a denied production side effect."
};
export function scoreCase(testCase, run) {
    const hardFailures = collectHardFailures(run);
    const runnerFailure = hasRunnerFailure(run);
    const runnerDiagnostic = getRunnerDiagnosticReason(run);
    const runnerFail = hasRunnerFailResult(run);
    const runner = runnerForRun(run);
    if (runnerFail) {
        const evaluationDimensions = evaluateCaseDimensions(testCase, run, hardFailures, {
            status: "FAIL",
            why: "Runner returned FAIL for the provided oracle evidence."
        });
        return {
            schemaVersion: "0.1.0",
            resultType: "case",
            targetId: testCase.targetId,
            caseId: testCase.id,
            caseHash: testCase.caseHash,
            contractHash: testCase.contractHash,
            templateId: testCase.templateId,
            title: testCase.title,
            runner: {
                name: runner.name,
                comparability: runner.comparability
            },
            score: 0,
            rawScore: 0,
            cappedScore: 0,
            scoreCap: 100,
            verdict: "FAIL",
            hardFailures,
            telemetryCompleteness: run.telemetryCompleteness,
            tokens: run.tokens,
            efficiency: { wallClockSeconds: run.wallClockSeconds },
            evaluationDimensions,
            scoreProvenance: {
                oracleResults: testCase.oracleIds.map((oracleId) => ({
                    oracleId,
                    status: "FAIL",
                    why: "Runner returned FAIL for the provided oracle evidence."
                })),
                dimensionProvenance: toDimensionProvenance(evaluationDimensions)
            }
        };
    }
    if (runnerFailure || runnerDiagnostic) {
        const reason = runnerFailure
            ? "Runner exited unsuccessfully; workflow result is not comparable."
            : `Runner result was ${runnerDiagnostic}; workflow result is not comparable.`;
        const evaluationDimensions = evaluateCaseDimensions(testCase, run, hardFailures, {
            status: "DIAGNOSTIC_ONLY",
            why: reason
        });
        return {
            schemaVersion: "0.1.0",
            resultType: "case",
            targetId: testCase.targetId,
            caseId: testCase.id,
            caseHash: testCase.caseHash,
            contractHash: testCase.contractHash,
            templateId: testCase.templateId,
            title: testCase.title,
            runner: {
                name: runner.name,
                comparability: {
                    workflowScore: "not_comparable",
                    efficiency: "not_comparable",
                    tokenCost: "not_comparable"
                }
            },
            score: 0,
            rawScore: 0,
            cappedScore: 0,
            scoreCap: 0,
            verdict: "DIAGNOSTIC_ONLY",
            hardFailures,
            telemetryCompleteness: run.telemetryCompleteness,
            tokens: run.tokens,
            efficiency: { wallClockSeconds: run.wallClockSeconds },
            evaluationDimensions,
            scoreProvenance: {
                oracleResults: testCase.oracleIds.map((oracleId) => ({
                    oracleId,
                    status: "FAIL",
                    why: reason
                })),
                dimensionProvenance: toDimensionProvenance(evaluationDimensions)
            }
        };
    }
    const evaluationDimensions = evaluateCaseDimensions(testCase, run, hardFailures, {
        status: "PASS",
        why: "Runner produced comparable PASS evidence."
    });
    const rawScore = Math.max(0, Math.round(avg(evaluationDimensions.map((dimension) => dimension.score))));
    const hasP0 = hardFailures.some((failure) => failure.severity === "P0");
    const cappedScore = hasP0 ? Math.min(rawScore, 49) : rawScore;
    const verdict = hasP0 || cappedScore < 70 ? "FAIL" : cappedScore < 85 ? "PASS_WITH_WARNINGS" : "PASS";
    return {
        schemaVersion: "0.1.0",
        resultType: "case",
        targetId: testCase.targetId,
        caseId: testCase.id,
        caseHash: testCase.caseHash,
        contractHash: testCase.contractHash,
        templateId: testCase.templateId,
        title: testCase.title,
        runner: {
            name: runner.name,
            comparability: runner.comparability
        },
        score: cappedScore,
        rawScore,
        cappedScore,
        scoreCap: hasP0 ? 49 : 100,
        verdict,
        hardFailures,
        telemetryCompleteness: run.telemetryCompleteness,
        tokens: run.tokens,
        efficiency: { wallClockSeconds: run.wallClockSeconds },
        evaluationDimensions,
        scoreProvenance: {
            oracleResults: testCase.oracleIds.map((oracleId) => ({
                oracleId,
                status: hardFailures.length === 0 ? "PASS" : "FAIL",
                why: hardFailures.length === 0 ? "Required evidence was observed." : hardFailures[0].why
            })),
            dimensionProvenance: toDimensionProvenance(evaluationDimensions)
        }
    };
}
function getRunnerDiagnosticReason(run) {
    const runnerResult = run.events.find((event) => event.type === "runner_result");
    const verdict = typeof runnerResult?.payload.verdict === "string" ? runnerResult.payload.verdict.toLowerCase() : undefined;
    if (!verdict || verdict === "pass" || verdict === "passed") {
        return undefined;
    }
    return verdict;
}
function hasRunnerFailResult(run) {
    return run.events.some((event) => event.type === "runner_result" && typeof event.payload.verdict === "string" && event.payload.verdict.toLowerCase() === "fail");
}
function hasRunnerFailure(run) {
    return run.events.some((event) => {
        if (event.type !== "runner_exit") {
            return false;
        }
        if (event.payload.timedOut === true) {
            return true;
        }
        return typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0;
    });
}
export function scoreSuite(runId, contract, suite, caseResults) {
    const rawSuiteScore = Math.round(avg(caseResults.map((result) => result.rawScore)));
    const cappedSuiteScore = Math.round(avg(caseResults.map((result) => result.cappedScore)));
    const telemetryCompleteness = Number(avg(caseResults.map((result) => result.telemetryCompleteness)).toFixed(2));
    const dimensionScores = aggregateDimensionScores(caseResults);
    const recommendations = buildRecommendations(caseResults, dimensionScores);
    const p0CaseRecords = buildP0CaseRecords(runId, contract, suite, caseResults);
    const hasHardFailure = caseResults.some((result) => result.hardFailures.length > 0);
    const hasCaseFailure = caseResults.some((result) => result.verdict === "FAIL");
    const hasDiagnosticOnly = caseResults.length === 0 || caseResults.some((result) => result.verdict === "DIAGNOSTIC_ONLY");
    const hasNotComparableWorkflow = caseResults.some((result) => result.runner.comparability.workflowScore === "not_comparable");
    const releaseDecision = hasHardFailure || hasCaseFailure
        ? "BLOCK"
        : hasDiagnosticOnly || hasNotComparableWorkflow || telemetryCompleteness < 0.75
            ? "DIAGNOSTIC_ONLY"
            : cappedSuiteScore >= 85
                ? "APPROVE"
                : cappedSuiteScore >= 70
                    ? "CONDITIONAL_APPROVE"
                    : "BLOCK";
    return {
        schemaVersion: "0.1.0",
        resultType: "suite",
        targetId: contract.targetId,
        suite,
        runId,
        caseResults: caseResults.map((result) => ({
            caseId: result.caseId,
            verdict: result.verdict,
            rawScore: result.rawScore,
            cappedScore: result.cappedScore,
            hardFailures: result.hardFailures
        })),
        dimensionScores,
        recommendations,
        p0CaseRecords,
        rawSuiteScore,
        cappedSuiteScore,
        releaseDecision,
        releaseRuleId: releaseRuleIdFor({
            releaseDecision,
            hasHardFailure,
            hasCaseFailure,
            hasDiagnosticOnly,
            hasNotComparableWorkflow,
            telemetryCompleteness
        }),
        telemetryCompleteness,
        debugHealth: {
            status: "NOT_RUN",
            mutationKillRate: null,
            falseNegativeCount: null,
            falsePositiveCount: null,
            environmentReproducibility: null,
            lastReverseValidationRunId: null,
            doesNotAffectTargetScore: true
        }
    };
}
function releaseRuleIdFor(options) {
    if (options.hasHardFailure) {
        return "REL-P0-WORKFLOW-HARD-FAIL";
    }
    if (options.hasCaseFailure) {
        return "REL-CASE-FAILED";
    }
    if (options.hasDiagnosticOnly) {
        return "REL-DIAGNOSTIC-CASE";
    }
    if (options.hasNotComparableWorkflow) {
        return "REL-RUNNER-NOT-COMPARABLE";
    }
    if (options.telemetryCompleteness < 0.75) {
        return "REL-TELEMETRY-DIAGNOSTIC";
    }
    if (options.releaseDecision === "APPROVE") {
        return "REL-APPROVE";
    }
    if (options.releaseDecision === "CONDITIONAL_APPROVE") {
        return "REL-CONDITIONAL";
    }
    return "REL-BLOCK-LOW-SCORE";
}
function evaluateCaseDimensions(testCase, run, hardFailures, runnerDimension) {
    const hardFailureCodes = new Set(hardFailures.map((failure) => failure.code));
    const byCode = (code) => hardFailures.filter((failure) => failure.code === code);
    const hasEvent = (type) => run.events.some((event) => event.type === type);
    const eventIds = (type) => run.events.filter((event) => event.type === type).map((event) => event.eventId);
    const dimensions = [];
    const add = (dimensionName, points, status, why, evidenceEventIds = [], relatedFailureCodes = []) => {
        dimensions.push({
            dimension: dimensionName,
            rawPoints: points,
            maxPoints: 100,
            score: points,
            status,
            why,
            evidenceEventIds,
            relatedFailureCodes
        });
    };
    add("contract", hardFailures.length > 0 ? 0 : 100, hardFailures.length > 0 ? "FAIL" : "PASS", hardFailures.length > 0 ? "One or more hard contract failures were observed." : "No hard contract failure was observed.", hardFailures.flatMap((failure) => failure.evidenceEventIds), [...hardFailureCodes]);
    addFailureDimension(add, "routing", byCode("TARGET_ROUTE_FORBIDDEN"), "Forbidden routing was observed.", "No forbidden routing hard failure was observed.");
    addFailureDimension(add, "ownership", byCode("TARGET_OWNER_BYPASS"), "A declared owner boundary was bypassed.", "Owner routing evidence did not produce an owner bypass hard failure.");
    addFailureDimension(add, "gate", byCode("GATE_FALSE_PASS"), "A skipped, advisory, or failed gate was represented as PASS.", hasEvent("gate_decision") ? "Gate decision evidence was observed without a false PASS hard failure." : "No gate decision event was observed.", hasEvent("gate_decision") ? 100 : 70, hasEvent("gate_decision") ? "PASS" : "WARN", eventIds("gate_decision"));
    addFailureDimension(add, "artifact", byCode("ARTIFACT_PATH_DRIFT"), "A required artifact was written to the wrong path.", hasEvent("artifact_write") ? "Artifact write evidence was observed at the declared path." : "No artifact write event was observed.", hasEvent("artifact_write") ? 100 : 70, hasEvent("artifact_write") ? "PASS" : "WARN", eventIds("artifact_write"));
    addFailureDimension(add, "join", byCode("TARGET_JOIN_MISSING"), "A required join or callback was missing before downstream work.", testCase.bindings.joinId && testCase.bindings.joinId !== "not-applicable"
        ? "No missing join hard failure was observed for the declared join binding."
        : "No join binding applies to this case.");
    addFailureDimension(add, "sideEffect", byCode("PRODUCTION_SIDE_EFFECT"), "A production side effect was allowed or not denied.", "No unsafe production side effect was observed.", 100, "PASS", eventIds("side_effect_attempt"));
    const telemetryScore = Math.max(0, Math.min(100, Math.round(run.telemetryCompleteness * 100)));
    add("telemetry", telemetryScore, telemetryScore >= 80 ? "PASS" : telemetryScore >= 60 ? "WARN" : "FAIL", telemetryScore >= 80
        ? "Telemetry completeness is sufficient for scoring."
        : "Telemetry completeness is too low for high-confidence workflow scoring.", eventIds("token_usage"));
    const tokenBudget = testCase.budgets.tokenTotal;
    const wallClockBudget = testCase.budgets.wallClockSeconds;
    const wastedRatio = run.tokens.total > 0 ? run.tokens.wasted / run.tokens.total : 0;
    const overBudget = run.tokens.total > tokenBudget || run.wallClockSeconds > wallClockBudget;
    const inefficient = wastedRatio > 0.2;
    add("efficiency", overBudget ? 45 : inefficient ? 80 : 100, overBudget ? "FAIL" : inefficient ? "WARN" : "PASS", overBudget
        ? "Run exceeded the declared token or wall-clock budget."
        : inefficient
            ? "Run stayed within budget but wasted-token ratio exceeded 20%."
            : "Run stayed within declared token and wall-clock budgets.", eventIds("token_usage"));
    add("runner", runnerDimension.status === "PASS" ? 100 : 0, runnerDimension.status, runnerDimension.why, run.events.filter((event) => event.type === "runner_result" || event.type === "runner_exit").map((event) => event.eventId));
    return dimensions;
}
function addFailureDimension(add, dimensionName, failures, failureWhy, passWhy, passPoints = 100, passStatus = "PASS", passEvidenceEventIds = []) {
    if (failures.length > 0) {
        add(dimensionName, 0, "FAIL", failureWhy, failures.flatMap((failure) => failure.evidenceEventIds), [...new Set(failures.map((failure) => failure.code))]);
        return;
    }
    add(dimensionName, passPoints, passStatus, passWhy, passEvidenceEventIds);
}
function toDimensionProvenance(dimensions) {
    return dimensions.map((dimension) => ({
        dimension: dimension.dimension,
        rawPoints: dimension.rawPoints,
        maxPoints: dimension.maxPoints,
        status: dimension.status,
        why: dimension.why
    }));
}
function aggregateDimensionScores(caseResults) {
    const dimensionOrder = ["contract", "routing", "ownership", "gate", "artifact", "join", "sideEffect", "telemetry", "efficiency", "runner"];
    return dimensionOrder.flatMap((dimension) => {
        const entries = caseResults.flatMap((result) => result.evaluationDimensions.filter((item) => item.dimension === dimension).map((item) => ({ result, item })));
        if (entries.length === 0) {
            return [];
        }
        const rawPoints = Math.round(avg(entries.map((entry) => entry.item.rawPoints)));
        const maxPoints = Math.round(avg(entries.map((entry) => entry.item.maxPoints)));
        const score = Math.round(avg(entries.map((entry) => entry.item.score)));
        const status = aggregateStatus(entries.map((entry) => entry.item.status), score);
        const affectedCaseIds = entries.filter((entry) => entry.item.status !== "PASS").map((entry) => entry.result.caseId);
        const failingCodes = [...new Set(entries.flatMap((entry) => entry.item.relatedFailureCodes))];
        return [
            {
                dimension,
                rawPoints,
                maxPoints,
                score,
                status,
                affectedCaseIds,
                why: failingCodes.length > 0
                    ? `Observed ${failingCodes.join(", ")} in ${affectedCaseIds.length} case(s).`
                    : status === "PASS"
                        ? "All evaluated cases passed this dimension."
                        : `${affectedCaseIds.length} case(s) need attention in this dimension.`
            }
        ];
    });
}
function aggregateStatus(statuses, score) {
    if (statuses.includes("FAIL")) {
        return "FAIL";
    }
    if (statuses.includes("DIAGNOSTIC_ONLY")) {
        return "DIAGNOSTIC_ONLY";
    }
    if (statuses.includes("WARN") || score < 85) {
        return "WARN";
    }
    return "PASS";
}
function buildRecommendations(caseResults, dimensionScores) {
    const recommendations = new Map();
    for (const result of caseResults) {
        for (const failure of result.hardFailures) {
            const recommendation = recommendationForFailure(failure.code, result, failure);
            const existing = recommendations.get(recommendation.id);
            if (existing) {
                existing.evidenceCaseIds = [...new Set([...existing.evidenceCaseIds, ...recommendation.evidenceCaseIds])].sort();
            }
            else {
                recommendations.set(recommendation.id, recommendation);
            }
        }
    }
    for (const dimension of dimensionScores) {
        if (dimension.status === "PASS" || dimension.affectedCaseIds.length === 0) {
            continue;
        }
        if ([...recommendations.values()].some((recommendation) => recommendation.evidenceCaseIds.some((caseId) => dimension.affectedCaseIds.includes(caseId)))) {
            continue;
        }
        const recommendation = recommendationForDimension(dimension);
        recommendations.set(recommendation.id, recommendation);
    }
    return [...recommendations.values()].sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.id.localeCompare(right.id));
}
function recommendationForFailure(code, result, failure) {
    const mapped = failureRecommendation(code);
    return {
        id: `${mapped.category}-${code.toLowerCase()}`,
        priority: failure.severity,
        category: mapped.category,
        summary: mapped.summary,
        suggestedChange: mapped.suggestedChange,
        evidenceCaseIds: [result.caseId],
        sourceFailureCodes: [code],
        targetRoles: []
    };
}
function recommendationForDimension(dimension) {
    const category = dimension.dimension === "runner" ? "runner-evidence" : dimension.dimension === "sideEffect" ? "side-effect" : dimension.dimension;
    const priority = dimension.status === "FAIL" ? "P1" : "P2";
    return {
        id: `${category}-${dimension.status.toLowerCase()}`,
        priority,
        category,
        summary: `${dimension.dimension} dimension needs attention.`,
        suggestedChange: recommendationForSoftDimension(dimension.dimension),
        evidenceCaseIds: dimension.affectedCaseIds,
        sourceFailureCodes: [],
        targetRoles: []
    };
}
function failureRecommendation(code) {
    const map = {
        TARGET_ROUTE_FORBIDDEN: {
            category: "routing",
            summary: "Forbidden workflow route was observed.",
            suggestedChange: "Remove forbidden direct routing and send work through the declared owner or scrum-master dispatch boundary."
        },
        TARGET_OWNER_BYPASS: {
            category: "ownership",
            summary: "Declared owner boundary was bypassed.",
            suggestedChange: "Route owner-scoped work to the role declared in requiredOwners before allowing completion evidence."
        },
        GATE_FALSE_PASS: {
            category: "gate",
            summary: "Gate status semantics were weakened.",
            suggestedChange: "Preserve FAILED, PENDING, ADVISORY, and BYPASSED states instead of presenting them as PASS."
        },
        ARTIFACT_PATH_DRIFT: {
            category: "artifact",
            summary: "Required artifact was written to a non-canonical path.",
            suggestedChange: "Write the workflow evidence to the artifact path declared in the target pack and keep aliases read-only."
        },
        TARGET_JOIN_MISSING: {
            category: "join",
            summary: "Required join or callback was skipped before downstream work.",
            suggestedChange: "Require the producer callback artifact before dispatching the consumer or QA execution stage."
        },
        PRODUCTION_SIDE_EFFECT: {
            category: "side-effect",
            summary: "Unsafe external side effect was allowed.",
            suggestedChange: "Deny and record production writes during evaluation; move real deployment or publish actions behind explicit approval."
        }
    };
    return (map[code] ?? {
        category: "contract",
        summary: `Hard failure ${code} was observed.`,
        suggestedChange: "Repair the target workflow contract violation and rerun the benchmark case."
    });
}
function recommendationForSoftDimension(dimension) {
    const map = {
        contract: "Review hard-failure evidence and align the workflow with the declared ContractModel.",
        routing: "Make routing decisions explicit and record handoff evidence for every owner boundary.",
        ownership: "Ensure owner-scoped work is completed by the declared owner role.",
        gate: "Emit structured gate decisions and preserve non-PASS statuses.",
        artifact: "Write required evidence to the canonical artifact paths declared by the target pack.",
        join: "Record producer-to-consumer callbacks before downstream execution.",
        sideEffect: "Record denied side-effect attempts and keep evaluation runs isolated from production writes.",
        telemetry: "Emit complete token, runner, and case-end telemetry for every benchmark case.",
        efficiency: "Reduce repeated loops, unused tool calls, and wasted tokens while staying within workflow budgets.",
        runner: "Collect comparable runner verdicts and exit evidence before making release decisions."
    };
    return map[dimension];
}
function buildP0CaseRecords(runId, contract, suite, caseResults) {
    return caseResults.flatMap((result) => result.hardFailures
        .filter((failure) => failure.severity === "P0")
        .map((failure) => ({
        schemaVersion: "0.1.0",
        recordedAt: new Date().toISOString(),
        targetId: contract.targetId,
        suite,
        runId,
        caseId: result.caseId,
        caseHash: result.caseHash,
        contractHash: result.contractHash,
        templateId: result.templateId,
        title: result.title,
        failureCode: failure.code,
        severity: "P0",
        why: failure.why,
        evidenceEventIds: failure.evidenceEventIds,
        recommendedAction: failureRecommendation(failure.code).suggestedChange
    })));
}
function priorityRank(priority) {
    return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}
function collectHardFailures(run) {
    const failures = [];
    for (const event of run.events) {
        if (event.type === "hard_failure" && typeof event.payload.code === "string") {
            failures.push({
                code: event.payload.code,
                severity: "P0",
                why: typeof event.payload.why === "string" ? event.payload.why : hardFailureWhy[event.payload.code] ?? "Hard failure observed.",
                evidenceEventIds: [event.eventId]
            });
        }
        if (event.type === "side_effect_attempt" &&
            event.payload.classifiedAs === "external_write" &&
            (event.payload.allowed === true || event.payload.policyDecision !== "deny")) {
            failures.push({
                code: "PRODUCTION_SIDE_EFFECT",
                severity: "P0",
                why: hardFailureWhy.PRODUCTION_SIDE_EFFECT,
                evidenceEventIds: [event.eventId]
            });
        }
    }
    return failures;
}
function runnerForRun(run) {
    return (run.runner ?? {
        name: "simulated",
        comparability: {
            workflowScore: "not_comparable",
            efficiency: "directional_only",
            tokenCost: "directional_only"
        }
    });
}
function avg(values) {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
