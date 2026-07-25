import { getCriterionValidityPolicy, getReliabilityPolicy } from "../evaluation/evaluationContract.js";
import { loadGoldCorpusSplits, scoreGoldCorpusCase } from "../evaluation/goldCorpus.js";
import { semanticCaseSetHash } from "../regression/provenance.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { baselineGatePolicyRules, compareGatePolicyBindings, createGatePolicy, gatePolicyBinding, loadCanonicalGatePolicy, loadGatePolicy, reviseGatePolicy } from "./policyArtifact.js";
export { compareGatePolicyBindings, gatePolicyBinding, loadCanonicalGatePolicy, loadGatePolicy, reviseGatePolicy };
export function renderCalibrationMarkdown(report) {
    const lines = [
        "# Agent Workflow Bench Gate Policy Calibration",
        "",
        `Status: ${report.status}`,
        `Assessment: ${report.assessmentType}`,
        `Release eligible: ${report.releaseEligible}`,
        `Policy: ${report.policy.policyId}@${report.policy.policyVersion}`,
        `Policy hash: ${report.policy.policyHash}`,
        `Rules hash: ${report.policy.rulesHash}`,
        `Fit splits: ${report.dataBoundary.fitSplits.join(", ")}`,
        `Fit sample size: ${report.fit.metrics.sampleSize}`,
        `Holdout excluded during fit: ${report.dataBoundary.holdoutExcludedFromFit}`,
        "",
        "## Fit metrics",
        "",
        `- P0 recall: ${report.fit.metrics.p0Recall ?? "insufficient sample"}`,
        `- False PASS count: ${report.fit.metrics.falsePassCount}`,
        `- Overall agreement: ${report.fit.metrics.overallAgreement ?? "insufficient sample"}`,
        `- Cohen kappa: ${report.fit.metrics.cohenKappa ?? "insufficient sample"}`,
        `- Candidate selection: ${report.fit.candidateSelection.selectedCandidateId} (${report.fit.candidateSelection.candidateCount} evaluated)`,
        "",
        "## Dimension evidence",
        "",
        ...report.fit.dimensionEvidence.map((item) => `- ${item.dimension}: weight=${item.weight}; safeMean=${item.safeMeanScore}; riskMean=${item.riskMeanScore}; pairedEffect=${item.pairedEffect}; ${Math.round(item.interval.confidenceLevel * 100)}% bootstrap=[${item.interval.lower}, ${item.interval.upper}]; support=${item.supportCount}/${item.status}`),
        "",
        "## Threshold evidence",
        "",
        `- Telemetry minimum: ${report.fit.thresholdEvidence.telemetry.minimumCompleteness}; support=${report.fit.thresholdEvidence.telemetry.supportCount}/${report.fit.thresholdEvidence.telemetry.status}`,
        `- Token budget ratio maximum: ${report.fit.thresholdEvidence.budget.maximumTokenBudgetRatio}`,
        `- Wall-clock budget ratio maximum: ${report.fit.thresholdEvidence.budget.maximumWallClockBudgetRatio}`,
        `- Wasted-token warning ratio: ${report.fit.thresholdEvidence.budget.wastedRatioWarning}; support=${report.fit.thresholdEvidence.budget.supportCount}/${report.fit.thresholdEvidence.budget.status}`,
        `- Meaningful score delta: ${report.fit.thresholdEvidence.classification.minimumMeaningfulScoreDelta}`
    ];
    if (report.holdout) {
        lines.push("", "## Unseen holdout", "", `- Sample size: ${report.holdout.sampleSize}`, `- P0 recall: ${report.holdout.p0Recall.pointEstimate}; ${Math.round(report.holdout.p0Recall.interval.confidenceLevel * 100)}% ${report.holdout.p0Recall.interval.kind}=[${report.holdout.p0Recall.interval.lower}, ${report.holdout.p0Recall.interval.upper}]`, `- False PASS count: ${report.holdout.falsePassCount}`, `- Overall agreement: ${report.holdout.overallAgreement.pointEstimate}`, `- Cohen kappa: ${report.holdout.cohenKappa.pointEstimate}`, `- Deterministic harness gate stability: ${report.holdout.stability.gateDecisionStability.pointEstimate}`);
    }
    lines.push("", "## Blockers", "", ...(report.blockers.length === 0
        ? ["- none"]
        : report.blockers.map((blocker) => `- ${blocker.severity} ${blocker.code}: ${blocker.why}`)), "", "This public Gold Corpus assessment is harness-diagnostic and cannot authorize production blocking.");
    return lines.join("\n");
}
export async function fitGatePolicy(options) {
    assertUniqueBenchmarkCases(options.cases);
    const corpus = await loadGoldCorpusSplits(options.corpusPath, [
        "development",
        "calibration"
    ]);
    const scored = scoreSelectedCases({
        corpus,
        contract: options.contract,
        cases: options.cases,
        splits: ["development", "calibration"]
    });
    const derivedFrom = dataSource(corpus, scored);
    const baselineRules = baselineGatePolicyRules();
    const candidates = candidateEvaluations(scored, baselineRules);
    const selected = selectCandidate(candidates);
    if (selected.metrics.p0Recall !== 1 ||
        selected.metrics.falsePassCount !== 0) {
        throw new Error("Gate policy calibration found no safe candidate with complete P0 recall and zero false PASS.");
    }
    const rules = selected.rules;
    const policy = options.previousPolicy
        ? reviseGatePolicy(options.previousPolicy, {
            policyVersion: options.policyVersion,
            rules,
            derivedFrom
        })
        : createGatePolicy({
            policyVersion: options.policyVersion,
            rules,
            derivedFrom
        });
    return {
        policy,
        report: buildFitReport({
            corpus,
            policy,
            scored,
            candidates,
            selected,
            status: "PENDING_HOLDOUT"
        })
    };
}
export async function validateGatePolicyHoldout(options) {
    assertUniqueBenchmarkCases(options.cases);
    assertCalibrationReportIntegrity(options.calibrationReport);
    if (options.calibrationReport.status !== "PENDING_HOLDOUT" ||
        options.calibrationReport.holdout !== undefined ||
        options.calibrationReport.blockers.length !== 0) {
        throw new Error("Gate policy holdout validation requires an untampered PENDING_HOLDOUT calibration report.");
    }
    const bindingComparison = compareGatePolicyBindings(options.calibrationReport.policy, gatePolicyBinding(options.policy));
    if (bindingComparison.status !== "RECOMPUTABLE") {
        throw new Error(`Gate policy holdout validation cannot reuse calibration report: ${bindingComparison.reasonCode}.`);
    }
    const corpus = await loadGoldCorpusSplits(options.corpusPath, ["holdout"]);
    if (corpus.manifestHash !==
        options.policy.derivedFrom.goldCorpus.corpusHash) {
        throw new Error("Gate policy holdout corpus does not match the manifest frozen during calibration.");
    }
    if (stableJson(options.calibrationReport.dataBoundary) !==
        stableJson({
            ...options.policy.derivedFrom,
            holdoutExcludedFromFit: true
        })) {
        throw new Error("Gate policy calibration report data boundary does not match the policy.");
    }
    const recomputedFit = await fitGatePolicy({
        corpusPath: options.corpusPath,
        contract: options.contract,
        cases: options.cases,
        policyVersion: options.policy.policyVersion
    });
    if (stableJson(recomputedFit.policy) !== stableJson(options.policy) ||
        stableJson(recomputedFit.report) !==
            stableJson(options.calibrationReport)) {
        throw new Error("Gate policy calibration report does not match the frozen fit evidence.");
    }
    const scoreHoldout = () => scoreSelectedCases({
        corpus,
        contract: options.contract,
        cases: options.cases,
        splits: ["holdout"],
        rules: options.policy.rules
    });
    const scored = scoreHoldout();
    const holdout = holdoutMetrics(scored, scoreHoldout);
    const blockers = holdoutBlockers(holdout);
    const { integrity: _fitIntegrity, ...fitReport } = options.calibrationReport;
    return withIntegrity({
        ...fitReport,
        status: blockers.length === 0 ? "PASS" : "FAIL",
        dataBoundary: {
            ...options.calibrationReport.dataBoundary,
            splitHashes: {
                ...options.calibrationReport.dataBoundary.splitHashes,
                holdout: splitHash(corpus, "holdout")
            }
        },
        holdout,
        blockers
    });
}
function buildFitReport(options) {
    const candidateHash = sha256Text(stableJson(options.candidates));
    return withIntegrity({
        schemaVersion: "0.1.0",
        reportType: "gate_policy_calibration",
        assessmentType: "harness_diagnostic",
        releaseEligible: false,
        status: options.status,
        policy: gatePolicyBinding(options.policy),
        dataBoundary: {
            ...options.policy.derivedFrom,
            holdoutExcludedFromFit: true
        },
        fit: {
            metrics: options.selected.metrics,
            candidateSelection: {
                selectedCandidateId: options.selected.candidateId,
                selectionRule: "Deterministic lexicographic selection over development/calibration only: require P0 recall 1 and false PASS 0, maximize agreement then kappa, prefer canonical baseline on ties.",
                candidateCount: options.candidates.length,
                candidateHash
            },
            dimensionEvidence: dimensionEvidence(options.scored, options.policy),
            thresholdEvidence: thresholdEvidence(options.scored, options.policy)
        },
        blockers: []
    });
}
function candidateEvaluations(scored, baselineRules) {
    const candidates = [
        {
            candidateId: "canonical-baseline",
            rules: baselineRules
        },
        {
            candidateId: "evidence-weighted-dimensions",
            rules: evidenceWeightedRules(scored, baselineRules)
        },
        {
            candidateId: "safety-bounded-thresholds",
            rules: safetyBoundedRules(baselineRules)
        }
    ];
    return candidates.map((candidate) => ({
        ...candidate,
        metrics: fitMetrics(rescoreCalibrationCases(scored, candidate.rules))
    }));
}
function selectCandidate(candidates) {
    return [...candidates].sort((left, right) => {
        const leftEligible = left.metrics.p0Recall === 1 && left.metrics.falsePassCount === 0 ? 1 : 0;
        const rightEligible = right.metrics.p0Recall === 1 && right.metrics.falsePassCount === 0 ? 1 : 0;
        if (leftEligible !== rightEligible) {
            return rightEligible - leftEligible;
        }
        if ((left.metrics.overallAgreement ?? 0) !== (right.metrics.overallAgreement ?? 0)) {
            return (right.metrics.overallAgreement ?? 0) - (left.metrics.overallAgreement ?? 0);
        }
        if ((left.metrics.cohenKappa ?? -1) !== (right.metrics.cohenKappa ?? -1)) {
            return (right.metrics.cohenKappa ?? -1) - (left.metrics.cohenKappa ?? -1);
        }
        return candidateSimplicity(left.candidateId) - candidateSimplicity(right.candidateId);
    })[0];
}
function candidateSimplicity(candidateId) {
    return candidateId === "canonical-baseline"
        ? 0
        : candidateId === "evidence-weighted-dimensions"
            ? 1
            : 2;
}
function evidenceWeightedRules(scored, rules) {
    const dimensionWeights = Object.fromEntries(Object.keys(rules.dimensionWeights)
        .sort()
        .map((dimension) => {
        const effects = pairedDimensionEffects(scored, dimension);
        const effect = Math.max(0, ratio(sum(effects), effects.length));
        return [dimension, round(rules.dimensionWeights[dimension] + effect / 100)];
    }));
    return {
        ...rules,
        dimensionWeights
    };
}
function safetyBoundedRules(rules) {
    return {
        ...rules,
        score: {
            ...rules.score,
            casePassMinimum: Math.min(100, rules.score.casePassMinimum + 1),
            suiteApproveMinimum: Math.min(100, rules.score.suiteApproveMinimum + 1),
            p0ScoreCap: Math.max(0, rules.score.p0ScoreCap - 1),
            p1ScoreCap: Math.max(0, rules.score.p1ScoreCap - 1)
        },
        telemetry: {
            ...rules.telemetry,
            minimumCompleteness: Math.min(1, round(rules.telemetry.minimumCompleteness + 0.01))
        },
        budget: {
            ...rules.budget,
            wastedRatioWarning: Math.max(0, round(rules.budget.wastedRatioWarning - 0.01))
        }
    };
}
function scoreSelectedCases(options) {
    assertCorpusBinding(options.corpus, options.contract, options.cases);
    const selectedSplits = new Set(options.splits);
    const casesById = new Map(options.cases.map((testCase) => [testCase.id, testCase]));
    const scored = options.corpus.cases
        .filter((entry) => selectedSplits.has(entry.split))
        .sort((left, right) => left.trajectory.id.localeCompare(right.trajectory.id))
        .map((entry) => {
        const benchmarkCase = casesById.get(entry.trajectory.benchmarkCaseId);
        if (!benchmarkCase) {
            throw new Error(`Gold Corpus trajectory ${entry.trajectory.id} references unknown benchmark case ${entry.trajectory.benchmarkCaseId}.`);
        }
        return {
            ...scoreGoldCorpusCase(options.corpus, entry, options.contract, benchmarkCase),
            benchmarkCase
        };
    });
    assertUniqueScoredEvidence(scored);
    return options.rules ? rescoreCalibrationCases(scored, options.rules) : scored;
}
function rescoreCalibrationCases(scored, rules) {
    return scored.map((item) => ({
        ...item,
        caseResult: rescoreCaseResult(item, rules)
    }));
}
function rescoreCaseResult(item, rules) {
    const dimensions = item.caseResult.evaluationDimensions.map((dimension) => {
        if (dimension.dimension !== "efficiency") {
            return { ...dimension };
        }
        const tokenRatio = ratio(item.caseResult.tokens.total, item.benchmarkCase.budgets.tokenTotal);
        const wallClockRatio = ratio(item.caseResult.efficiency.wallClockSeconds, item.benchmarkCase.budgets.wallClockSeconds);
        const wastedRatio = ratio(item.caseResult.tokens.wasted, item.caseResult.tokens.total);
        const overBudget = tokenRatio > rules.budget.maximumTokenBudgetRatio ||
            wallClockRatio > rules.budget.maximumWallClockBudgetRatio;
        const inefficient = wastedRatio > rules.budget.wastedRatioWarning;
        return {
            ...dimension,
            rawPoints: overBudget ? 45 : inefficient ? 80 : 100,
            score: overBudget ? 45 : inefficient ? 80 : 100,
            status: overBudget ? "FAIL" : inefficient ? "WARN" : "PASS"
        };
    });
    const totalWeight = dimensions.reduce((total, dimension) => total + rules.dimensionWeights[dimension.dimension], 0);
    const rawScore = totalWeight === 0
        ? 0
        : Math.round(dimensions.reduce((total, dimension) => total +
            dimension.score * rules.dimensionWeights[dimension.dimension], 0) / totalWeight);
    const hasP0 = item.caseResult.hardFailures.some((failure) => failure.severity === "P0");
    const hasP1 = item.caseResult.hardFailures.some((failure) => failure.severity === "P1");
    const diagnosticOnly = dimensions.some((dimension) => dimension.status === "DIAGNOSTIC_ONLY");
    const scoreCap = hasP0
        ? rules.score.p0ScoreCap
        : hasP1
            ? rules.score.p1ScoreCap
            : diagnosticOnly
                ? 0
                : 100;
    const cappedScore = Math.min(rawScore, scoreCap);
    const verdict = hasP0
        ? "FAIL"
        : diagnosticOnly
            ? "DIAGNOSTIC_ONLY"
            : cappedScore < rules.score.caseConditionalMinimum
                ? "FAIL"
                : cappedScore < rules.score.casePassMinimum
                    ? "PASS_WITH_WARNINGS"
                    : "PASS";
    return {
        ...item.caseResult,
        score: cappedScore,
        rawScore,
        cappedScore,
        scoreCap,
        verdict,
        evaluationDimensions: dimensions
    };
}
function fitMetrics(scored) {
    const metrics = baseMetrics(scored);
    return {
        sampleSize: scored.length,
        p0Recall: metrics.p0Recall,
        falsePassCount: metrics.falsePassCount,
        overallAgreement: metrics.overallAgreement,
        cohenKappa: metrics.cohenKappa
    };
}
function holdoutMetrics(scored, replay) {
    const metrics = baseMetrics(scored);
    const reliability = getReliabilityPolicy();
    const p0KnownBad = p0KnownBadCases(scored);
    const p0Detected = p0KnownBad.filter(isP0Detected).length;
    const agreements = agreementValues(scored);
    const kappaEstimate = metrics.cohenKappa ?? 0;
    const repeatCount = reliability.deterministicMinimumSamples;
    const repeatedScores = Array.from({ length: repeatCount }, replay);
    const classificationStability = repeatedStabilityMetric(repeatedScores.map(classificationSignature), reliability);
    const gateDecisionStability = repeatedStabilityMetric(repeatedScores.map(gateDecisionSignature), reliability);
    return {
        sampleSize: scored.length,
        p0Recall: {
            pointEstimate: metrics.p0Recall ?? 0,
            interval: wilson(p0Detected, p0KnownBad.length, reliability.confidenceLevel)
        },
        falsePassCount: metrics.falsePassCount,
        overallAgreement: {
            pointEstimate: metrics.overallAgreement ?? 0,
            interval: wilson(sum(agreements), agreements.length, reliability.confidenceLevel)
        },
        cohenKappa: {
            pointEstimate: kappaEstimate,
            interval: bootstrapKappaInterval(scored, reliability.bootstrapIterations, reliability.confidenceLevel, `${reliability.defaultSeed}:holdout-kappa`)
        },
        stability: {
            scope: "deterministic_harness_replay",
            sampleSize: repeatCount,
            confidenceLevel: reliability.confidenceLevel,
            classificationStability,
            gateDecisionStability
        }
    };
}
function classificationSignature(scored) {
    return stableJson(scored.map((item) => ({
        trajectoryId: item.corpusCase.trajectory.id,
        verdict: item.caseResult.verdict,
        score: item.caseResult.cappedScore,
        failures: item.observedFailureCodes
    })));
}
function gateDecisionSignature(scored) {
    const criterion = getCriterionValidityPolicy();
    const metrics = baseMetrics(scored);
    return stableJson({
        decision: metrics.p0Recall !== null &&
            metrics.p0Recall >= criterion.p0RecallMinimum &&
            metrics.falsePassCount <= criterion.maximumFalsePassCount &&
            metrics.overallAgreement !== null &&
            metrics.overallAgreement >= criterion.overallAgreementMinimum &&
            metrics.cohenKappa !== null &&
            metrics.cohenKappa >= criterion.cohenKappaMinimum
            ? "PASS"
            : "FAIL",
        metrics
    });
}
function repeatedStabilityMetric(signatures, reliability) {
    const firstSignature = signatures[0];
    const stable = signatures.map((signature) => signature === firstSignature ? 1 : 0);
    return {
        pointEstimate: ratio(sum(stable), stable.length),
        interval: bootstrapMeanInterval(stable, reliability.bootstrapIterations, reliability.confidenceLevel, reliability.defaultSeed)
    };
}
function baseMetrics(scored) {
    const p0KnownBad = p0KnownBadCases(scored);
    const agreements = agreementValues(scored);
    return {
        p0Recall: p0KnownBad.length === 0
            ? null
            : ratio(p0KnownBad.filter(isP0Detected).length, p0KnownBad.length),
        falsePassCount: scored.filter((item) => item.corpusCase.label.control === "known_bad" &&
            item.caseResult.verdict === "PASS").length,
        overallAgreement: agreements.length === 0 ? null : ratio(sum(agreements), agreements.length),
        cohenKappa: scored.length === 0 ? null : cohenKappa(scored)
    };
}
function dimensionEvidence(scored, policy) {
    const reliability = getReliabilityPolicy();
    return Object.entries(policy.rules.dimensionWeights)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dimension, weight]) => {
        const dimensionName = dimension;
        const safeScores = dimensionScores(scored, dimensionName, false);
        const riskScores = dimensionScores(scored, dimensionName, true);
        const pairedEffects = pairedDimensionEffects(scored, dimensionName);
        const safeMeanScore = ratio(sum(safeScores), safeScores.length);
        const riskMeanScore = ratio(sum(riskScores), riskScores.length);
        const supportCount = pairedEffects.length;
        return {
            dimension: dimensionName,
            weight,
            supportCount,
            safeMeanScore,
            riskMeanScore,
            pairedEffect: round(ratio(sum(pairedEffects), pairedEffects.length)),
            interval: bootstrapMeanInterval(pairedEffects.length > 0 ? pairedEffects : [0], reliability.bootstrapIterations, reliability.confidenceLevel, `${reliability.defaultSeed}:${dimension}`),
            status: supportCount === 0 ? "UNSUPPORTED" : supportCount < 2 ? "WEAK" : "SUPPORTED"
        };
    });
}
function pairedDimensionEffects(scored, dimension) {
    const byFailureCode = new Map();
    for (const item of scored) {
        const score = item.caseResult.evaluationDimensions.find((entry) => entry.dimension === dimension)?.score;
        if (typeof score !== "number") {
            continue;
        }
        const pair = byFailureCode.get(item.corpusCase.label.failureCode) ?? {
            safe: [],
            risk: []
        };
        if (item.corpusCase.label.control === "known_bad") {
            pair.risk.push(score);
        }
        else {
            pair.safe.push(score);
        }
        byFailureCode.set(item.corpusCase.label.failureCode, pair);
    }
    return [...byFailureCode.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, pair]) => pair.safe.length > 0 && pair.risk.length > 0
        ? [
            round(ratio(sum(pair.safe), pair.safe.length) -
                ratio(sum(pair.risk), pair.risk.length))
        ]
        : []);
}
function thresholdEvidence(scored, policy) {
    const telemetrySupport = scored.filter((item) => item.caseResult.telemetryCompleteness >=
        policy.rules.telemetry.minimumCompleteness).length;
    const budgetSupport = scored.filter((item) => {
        const tokenRatio = ratio(item.caseResult.tokens.total, item.benchmarkCase.budgets.tokenTotal);
        const wallClockRatio = ratio(item.caseResult.efficiency.wallClockSeconds, item.benchmarkCase.budgets.wallClockSeconds);
        return (tokenRatio <= policy.rules.budget.maximumTokenBudgetRatio &&
            wallClockRatio <= policy.rules.budget.maximumWallClockBudgetRatio);
    }).length;
    return {
        caseThresholds: {
            passMinimum: policy.rules.score.casePassMinimum,
            conditionalMinimum: policy.rules.score.caseConditionalMinimum
        },
        suiteThresholds: {
            approveMinimum: policy.rules.score.suiteApproveMinimum,
            conditionalMinimum: policy.rules.score.suiteConditionalMinimum
        },
        scoreCaps: {
            p0: policy.rules.score.p0ScoreCap,
            p1: policy.rules.score.p1ScoreCap
        },
        telemetry: {
            minimumCompleteness: policy.rules.telemetry.minimumCompleteness,
            supportCount: telemetrySupport,
            status: supportStatus(telemetrySupport, scored.length)
        },
        budget: {
            maximumTokenBudgetRatio: policy.rules.budget.maximumTokenBudgetRatio,
            maximumWallClockBudgetRatio: policy.rules.budget.maximumWallClockBudgetRatio,
            wastedRatioWarning: policy.rules.budget.wastedRatioWarning,
            supportCount: budgetSupport,
            status: supportStatus(budgetSupport, scored.length)
        },
        classification: {
            minimumMeaningfulScoreDelta: policy.rules.classification.minimumMeaningfulScoreDelta
        }
    };
}
function holdoutBlockers(holdout) {
    const criterion = getCriterionValidityPolicy();
    const reliability = getReliabilityPolicy();
    const blockers = [];
    const add = (code, why, evidence) => {
        blockers.push({
            code,
            severity: "P0",
            why,
            evidenceHash: sha256Text(stableJson(evidence))
        });
    };
    if (holdout.p0Recall.pointEstimate < criterion.p0RecallMinimum) {
        add("P0_RECALL_BELOW_THRESHOLD", "Holdout P0 recall is below the canonical threshold.", holdout.p0Recall);
    }
    if (holdout.falsePassCount > criterion.maximumFalsePassCount) {
        add("FALSE_PASS_ABOVE_THRESHOLD", "Holdout false PASS count exceeds the canonical threshold.", holdout.falsePassCount);
    }
    if (holdout.overallAgreement.pointEstimate < criterion.overallAgreementMinimum) {
        add("OVERALL_AGREEMENT_BELOW_THRESHOLD", "Holdout agreement is below the canonical threshold.", holdout.overallAgreement);
    }
    if (holdout.stability.gateDecisionStability.pointEstimate <
        reliability.gateConsistencyMinimum) {
        add("STABILITY_BELOW_THRESHOLD", "Holdout gate-decision stability is below the canonical threshold.", holdout.stability);
    }
    if (holdout.cohenKappa.pointEstimate < criterion.cohenKappaMinimum) {
        add("KAPPA_BELOW_THRESHOLD", "Holdout Cohen kappa is below the canonical threshold.", holdout.cohenKappa);
    }
    return blockers;
}
function dataSource(corpus, scored) {
    return {
        goldCorpus: {
            corpusId: corpus.manifest.corpusId,
            corpusVersion: corpus.manifest.corpusVersion,
            corpusHash: corpus.manifestHash,
            labelsHash: sha256Text(stableJson([
                splitRef(corpus, "development").labelsHash,
                splitRef(corpus, "calibration").labelsHash
            ])),
            trajectoriesHash: sha256Text(stableJson([
                splitRef(corpus, "development").trajectoriesHash,
                splitRef(corpus, "calibration").trajectoriesHash
            ]))
        },
        fitSplits: ["development", "calibration"],
        splitHashes: {
            development: splitHash(corpus, "development"),
            calibration: splitHash(corpus, "calibration")
        },
        sampleCount: scored.length,
        sampleHash: sampleHash(scored)
    };
}
function splitRef(corpus, split) {
    const item = corpus.manifest.splits.find((entry) => entry.id === split);
    if (!item) {
        throw new Error(`Gold Corpus manifest is missing ${split} split.`);
    }
    return item;
}
function splitHash(corpus, split) {
    const item = splitRef(corpus, split);
    return sha256Text(stableJson({
        split,
        labelsHash: item.labelsHash,
        trajectoriesHash: item.trajectoriesHash
    }));
}
function sampleHash(scored) {
    return sha256Text(stableJson(scored.map((item) => ({
        split: item.corpusCase.split,
        trajectoryId: item.corpusCase.trajectory.id,
        benchmarkCaseId: item.corpusCase.trajectory.benchmarkCaseId,
        label: item.corpusCase.label,
        observedVerdict: item.caseResult.verdict,
        observedFailureCodes: item.observedFailureCodes
    }))));
}
function assertCorpusBinding(corpus, contract, cases) {
    if (corpus.manifest.targetId !== contract.targetId) {
        throw new Error(`Gold Corpus target mismatch: ${corpus.manifest.targetId} != ${contract.targetId}.`);
    }
    if (corpus.manifest.contractHash !== contract.contractHash) {
        throw new Error("Gold Corpus contractHash is stale.");
    }
    if (corpus.manifest.caseSetHash !== semanticCaseSetHash(cases)) {
        throw new Error("Gold Corpus caseSetHash is stale.");
    }
}
function assertUniqueBenchmarkCases(cases) {
    const ids = cases.map((testCase) => testCase.id);
    if (new Set(ids).size !== ids.length) {
        throw new Error("Gate policy calibration rejects duplicate benchmark case ids.");
    }
}
function assertUniqueScoredEvidence(scored) {
    const trajectoryIds = scored.map((item) => item.corpusCase.trajectory.id);
    if (new Set(trajectoryIds).size !== trajectoryIds.length) {
        throw new Error("Gate policy calibration rejects duplicate trajectory evidence.");
    }
    const evidenceKeys = scored.map((item) => stableJson({
        split: item.corpusCase.split,
        patches: item.corpusCase.trajectory.patches,
        label: item.corpusCase.label
    }));
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
        throw new Error("Gate policy calibration rejects duplicate sample evidence.");
    }
}
function withIntegrity(report) {
    const dataHash = sha256Text(stableJson(report.dataBoundary));
    const contentHash = sha256Text(stableJson(report));
    const partialIntegrity = {
        status: "VERIFIED_AT_WRITE",
        contentHash,
        policyHash: report.policy.policyHash,
        rulesHash: report.policy.rulesHash,
        dataHash
    };
    return {
        ...report,
        integrity: {
            ...partialIntegrity,
            reportHash: sha256Text(stableJson({ ...report, integrity: partialIntegrity }))
        }
    };
}
export function assertCalibrationReportIntegrity(report) {
    const { integrity, ...content } = report;
    const dataHash = sha256Text(stableJson(report.dataBoundary));
    const contentHash = sha256Text(stableJson(content));
    const partialIntegrity = {
        status: "VERIFIED_AT_WRITE",
        contentHash,
        policyHash: report.policy.policyHash,
        rulesHash: report.policy.rulesHash,
        dataHash
    };
    const reportHash = sha256Text(stableJson({ ...content, integrity: partialIntegrity }));
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== contentHash ||
        integrity.policyHash !== report.policy.policyHash ||
        integrity.rulesHash !== report.policy.rulesHash ||
        integrity.dataHash !== dataHash ||
        integrity.reportHash !== reportHash) {
        throw new Error("Gate policy calibration report integrity is invalid.");
    }
}
function p0KnownBadCases(scored) {
    return scored.filter((item) => item.corpusCase.label.control === "known_bad" &&
        item.corpusCase.label.severity === "P0");
}
function isP0Detected(item) {
    return (item.caseResult.verdict === "FAIL" &&
        item.corpusCase.label.expectedFailureCodes.every((code) => item.observedFailureCodes.includes(code)));
}
function agreementValues(scored) {
    return scored.map((item) => item.caseResult.verdict === item.corpusCase.label.expectedVerdict ? 1 : 0);
}
function dimensionScores(scored, dimension, risk) {
    return scored
        .filter((item) => (item.corpusCase.label.control === "known_bad") === risk)
        .map((item) => item.caseResult.evaluationDimensions.find((entry) => entry.dimension === dimension)?.score)
        .filter((score) => typeof score === "number");
}
function supportStatus(supportCount, sampleCount) {
    if (supportCount === 0) {
        return "UNSUPPORTED";
    }
    return supportCount === sampleCount ? "SUPPORTED" : "WEAK";
}
function cohenKappa(scored) {
    const labels = ["PASS", "PASS_WITH_WARNINGS", "FAIL", "DIAGNOSTIC_ONLY"];
    const expectedCounts = new Map(labels.map((label) => [label, 0]));
    const observedCounts = new Map(labels.map((label) => [label, 0]));
    let observedAgreement = 0;
    for (const item of scored) {
        expectedCounts.set(item.corpusCase.label.expectedVerdict, (expectedCounts.get(item.corpusCase.label.expectedVerdict) ?? 0) + 1);
        observedCounts.set(item.caseResult.verdict, (observedCounts.get(item.caseResult.verdict) ?? 0) + 1);
        if (item.corpusCase.label.expectedVerdict === item.caseResult.verdict) {
            observedAgreement += 1;
        }
    }
    const observed = observedAgreement / scored.length;
    const expected = labels.reduce((total, label) => total +
        ((expectedCounts.get(label) ?? 0) / scored.length) *
            ((observedCounts.get(label) ?? 0) / scored.length), 0);
    return expected === 1 ? (observed === 1 ? 1 : 0) : round((observed - expected) / (1 - expected));
}
function wilson(successes, samples, confidenceLevel) {
    if (samples === 0) {
        return { kind: "wilson", confidenceLevel, lower: 0, upper: 0 };
    }
    const z = confidenceLevel >= 0.99 ? 2.576 : confidenceLevel >= 0.95 ? 1.96 : 1.645;
    const phat = successes / samples;
    const denominator = 1 + (z * z) / samples;
    const center = phat + (z * z) / (2 * samples);
    const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * samples)) / samples);
    return {
        kind: "wilson",
        confidenceLevel,
        lower: round(Math.max(0, (center - margin) / denominator)),
        upper: round(Math.min(1, (center + margin) / denominator))
    };
}
function bootstrapMeanInterval(values, iterations, confidenceLevel, seed) {
    if (values.length === 0 || iterations <= 0) {
        return { kind: "bootstrap", confidenceLevel, lower: 0, upper: 0 };
    }
    let state = seedToUint32(seed);
    const means = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        let total = 0;
        for (let index = 0; index < values.length; index += 1) {
            state = nextUint32(state);
            total += values[state % values.length];
        }
        means.push(total / values.length);
    }
    means.sort((left, right) => left - right);
    const alpha = (1 - confidenceLevel) / 2;
    return {
        kind: "bootstrap",
        confidenceLevel,
        lower: round(means[Math.floor(alpha * (means.length - 1))] ?? 0),
        upper: round(means[Math.ceil((1 - alpha) * (means.length - 1))] ?? 0)
    };
}
function bootstrapKappaInterval(scored, iterations, confidenceLevel, seed) {
    if (scored.length === 0 || iterations <= 0) {
        return {
            kind: "bootstrap",
            confidenceLevel,
            lower: 0,
            upper: 0
        };
    }
    let state = seedToUint32(seed);
    const estimates = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const sample = [];
        for (let index = 0; index < scored.length; index += 1) {
            state = nextUint32(state);
            sample.push(scored[state % scored.length]);
        }
        estimates.push(cohenKappa(sample));
    }
    estimates.sort((left, right) => left - right);
    const alpha = (1 - confidenceLevel) / 2;
    return {
        kind: "bootstrap",
        confidenceLevel,
        lower: round(estimates[Math.floor(alpha * (estimates.length - 1))] ?? 0),
        upper: round(estimates[Math.ceil((1 - alpha) * (estimates.length - 1))] ?? 0)
    };
}
function seedToUint32(seed) {
    let hash = 2166136261;
    for (const char of seed) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function nextUint32(value) {
    let next = value;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    return next >>> 0;
}
function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}
function ratio(numerator, denominator) {
    return denominator === 0 ? 0 : round(numerator / denominator);
}
function round(value) {
    return Number(value.toFixed(6));
}
