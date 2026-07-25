import { getCriterionValidityPolicy, getHardFailureDefinition } from "../evaluation/evaluationContract.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { verifyExternalValidityComparisonEvidence } from "./comparisonEvidence.js";
const VERIFIED_OBSERVATIONS = Symbol("verified-external-validity-observations");
const CLASSIFICATIONS = [
    "IMPROVED",
    "UNCHANGED",
    "REGRESSED",
    "MIXED",
    "HARD_FAILURE",
    "INCOMPARABLE"
];
const GATE_DECISIONS = [
    "PASS",
    "BLOCK",
    "DIAGNOSTIC_ONLY"
];
const TARGET_CLASSES = [
    "directory",
    "cli",
    "hybrid"
];
const RUNNERS = ["codex", "claude"];
const DESIGN_STRATA = [
    "known_improvement",
    "no_change",
    "ordinary_regression",
    "p0_regression"
];
export function createExternalValidityLabelingPackage(study) {
    assertExternalValidityStudy(study);
    const targetsById = new Map(study.targets.map((target) => [target.targetId, target]));
    return {
        package: {
            schemaVersion: "0.1.0",
            resultType: "external_validity_labeling_package",
            studyId: study.studyId,
            status: "READY_FOR_HUMAN_LABELING",
            publicSafe: true,
            blinding: study.blinding,
            items: study.items.map((item) => {
                const target = targetsById.get(item.targetId);
                if (!target) {
                    throw new Error(`Study item ${item.itemId} references an unknown target.`);
                }
                return {
                    itemId: item.blindedChangeId,
                    blindedChangeId: item.blindedChangeId,
                    blindedTargetId: target.blindedTargetId,
                    targetClass: target.targetClass,
                    runnerBlindId: item.runnerBlindId,
                    baseline: publicArtifactRef(item.baseline),
                    candidate: publicArtifactRef(item.candidate)
                };
            })
        },
        labelsTemplate: {
            schemaVersion: "0.1.0",
            resultType: "external_validity_human_labels",
            studyId: study.studyId,
            status: "DRAFT",
            raters: [],
            labels: [],
            adjudications: []
        },
        observationsTemplate: {
            schemaVersion: "0.1.0",
            resultType: "external_validity_observations",
            studyId: study.studyId,
            status: "DRAFT",
            items: []
        }
    };
}
async function verifyExternalValidityObservations(study, observations, options) {
    assertExternalValidityStudy(study);
    const aliases = buildItemIdAliases(study);
    const studyItems = new Map(study.items.map((item) => [item.itemId, item]));
    const targets = new Map(study.targets.map((target) => [target.targetId, target]));
    const verified = new Map();
    await Promise.all(observations.items.map(async (manifestItem) => {
        const itemId = aliases.get(manifestItem.itemId) ?? manifestItem.itemId;
        const studyItem = studyItems.get(itemId);
        const target = studyItem ? targets.get(studyItem.targetId) : undefined;
        if (!studyItem || !target) {
            return;
        }
        const result = await verifyExternalValidityComparisonEvidence(manifestItem.evidence.comparisonRef, options);
        if (result.status !== "VALID" ||
            result.evidence.comparisonHash !==
                manifestItem.evidence.comparisonHash ||
            result.evidence.targetIdHash !== target.targetRefHash ||
            result.evidence.contractHash !== target.contractHash ||
            result.evidence.runner !== studyItem.runner ||
            result.evidence.baselineContentHash !==
                studyItem.baseline.contentHash ||
            result.evidence.candidateContentHash !==
                studyItem.candidate.contentHash) {
            return;
        }
        verified.set(itemId, {
            itemId,
            classification: result.evidence.classification,
            gateDecision: result.evidence.gateDecision,
            failureCodes: [...result.evidence.failureCodes],
            evidence: {
                comparisonHash: result.evidence.comparisonHash,
                attemptFingerprint: result.evidence.attemptFingerprint
            }
        });
    }));
    const output = {
        ...observations,
        items: observations.items.map((item) => ({ ...item }))
    };
    Object.defineProperty(output, VERIFIED_OBSERVATIONS, {
        value: verified,
        enumerable: false,
        configurable: false,
        writable: false
    });
    return output;
}
export async function analyzeExternalValidityFromComparisons(study, observations, labels, options) {
    return analyzeExternalValidity(study, await verifyExternalValidityObservations(study, observations, options), labels);
}
export function analyzeExternalValidity(study, observations, labels) {
    assertExternalValidityStudy(study);
    const policy = getCriterionValidityPolicy();
    const coverage = analyzeCoverage(study, policy);
    const blockers = new Set();
    const failures = new Set();
    const rawObservedItems = observations?.items ?? [];
    const verifiedObservations = observations && VERIFIED_OBSERVATIONS in observations
        ? observations[VERIFIED_OBSERVATIONS]
        : new Map();
    const observedItems = [...verifiedObservations.values()];
    const itemIdAliases = buildItemIdAliases(study);
    const humanLabels = (labels?.labels ?? []).map((label) => ({
        ...label,
        itemId: itemIdAliases.get(label.itemId) ?? label.itemId
    }));
    const adjudications = (labels?.adjudications ?? []).map((adjudication) => ({
        ...adjudication,
        itemId: itemIdAliases.get(adjudication.itemId) ?? adjudication.itemId
    }));
    const normalizedLabels = labels
        ? {
            ...labels,
            labels: humanLabels,
            adjudications
        }
        : undefined;
    if (!observations || observations.status !== "COMPLETE") {
        blockers.add("AWB_OBSERVATIONS_MISSING");
    }
    if (!labels || labels.status !== "COMPLETE") {
        blockers.add("HUMAN_LABELS_MISSING");
    }
    if (!coverage.complete) {
        blockers.add("COVERAGE_INCOMPLETE");
    }
    if (study.targets.some((target) => target.contractReview.status !== "reviewed")) {
        blockers.add("TARGET_CONTRACT_REVIEW_MISSING");
    }
    const observationManifestItems = rawObservedItems.map((item) => ({
        ...item,
        itemId: itemIdAliases.get(item.itemId) ?? item.itemId
    }));
    const observationManifestByItem = new Map(observationManifestItems.map((item) => [item.itemId, item]));
    const observationsByItem = new Map(observedItems.map((item) => [item.itemId, item]));
    const labelsByItem = groupByItem(humanLabels);
    const adjudicationsByItem = new Map(adjudications.map((item) => [item.itemId, item]));
    const studyItemIds = new Set(study.items.map((item) => item.itemId));
    const humanDecisions = [...humanLabels, ...adjudications];
    const humanDecisionsValid = humanDecisions.every(isValidDecisionRecord);
    if (observations &&
        (observations.schemaVersion !== "0.1.0" ||
            observations.resultType !== "external_validity_observations" ||
            !["DRAFT", "COMPLETE"].includes(observations.status) ||
            observations.studyId !== study.studyId ||
            observationManifestByItem.size !== observationManifestItems.length ||
            observationManifestItems.some((item) => !studyItemIds.has(item.itemId) ||
                !isValidObservationManifestItem(item)))) {
        blockers.add("AWB_OBSERVATIONS_INVALID");
    }
    if (normalizedLabels &&
        (normalizedLabels.schemaVersion !== "0.1.0" ||
            normalizedLabels.resultType !== "external_validity_human_labels" ||
            !["DRAFT", "COMPLETE"].includes(normalizedLabels.status) ||
            normalizedLabels.studyId !== study.studyId ||
            humanLabels.some((item) => !studyItemIds.has(item.itemId)) ||
            adjudications.some((item) => !studyItemIds.has(item.itemId)) ||
            !humanDecisionsValid ||
            containsDuplicateHumanLabels(humanLabels) ||
            adjudicationsByItem.size !== adjudications.length ||
            adjudications.some((item) => {
                const itemLabels = labelsByItem.get(item.itemId) ?? [];
                return (itemLabels.length !== policy.minimumIndependentRaters ||
                    labelsAgree(itemLabels));
            }))) {
        blockers.add("HUMAN_LABELS_INVALID");
    }
    if (normalizedLabels &&
        !hasIndependentRaters(normalizedLabels, policy.minimumIndependentRaters)) {
        blockers.add("INDEPENDENT_RATERS_MISSING");
    }
    const hasCompleteObservedItems = observedItems.length === study.items.length &&
        study.items.every((item) => observationsByItem.has(item.itemId));
    const hasCompleteHumanLabels = study.items.length > 0 &&
        study.items.every((item) => new Set((labelsByItem.get(item.itemId) ?? []).map((label) => label.raterId)).size === policy.minimumIndependentRaters);
    if (observations && !hasCompleteObservedItems) {
        blockers.add("AWB_OBSERVATIONS_INCOMPLETE");
    }
    if (labels && !hasCompleteHumanLabels) {
        blockers.add("HUMAN_LABELS_INCOMPLETE");
    }
    if (observations &&
        (verifiedObservations.size !== observationManifestItems.length ||
            observedItems.some((item) => !hasQualifiedLiveTrace(item)))) {
        blockers.add("UNQUALIFIED_EVIDENCE");
    }
    if (observations &&
        (containsDuplicateObservationManifests(observationManifestItems) ||
            containsDuplicateEvidence(observedItems))) {
        blockers.add("DUPLICATE_EVIDENCE");
    }
    if (labels && labels.blindingAttestation !== "awb_decision_hidden") {
        blockers.add("BLINDING_ATTESTATION_MISSING");
    }
    const decisionRecords = [...observedItems, ...humanDecisions];
    if (decisionRecords.some(hasUnknownFailureCode)) {
        blockers.add("UNKNOWN_FAILURE_CODE");
    }
    if (decisionRecords.some(hasMissingHardFailureCode)) {
        blockers.add("HARD_FAILURE_CODE_MISSING");
    }
    if (decisionRecords.some(hasInvalidP0GateSemantics)) {
        blockers.add("INVALID_P0_GATE_SEMANTICS");
    }
    if (decisionRecords.some(hasInvalidHardFailureSemantics)) {
        blockers.add("INVALID_HARD_FAILURE_SEMANTICS");
    }
    const unresolvedDisagreements = findUnresolvedDisagreements(labelsByItem, adjudicationsByItem);
    if (unresolvedDisagreements.size > 0) {
        blockers.add("UNRESOLVED_LABEL_DISAGREEMENT");
    }
    const metrics = calculateMetrics(study, observationsByItem, labelsByItem, adjudicationsByItem);
    if (metrics.falsePassCount !== null &&
        metrics.falsePassCount > policy.maximumFalsePassCount) {
        failures.add("FALSE_PASS_DETECTED");
    }
    const resolvedHumanTruth = labels?.status === "COMPLETE" &&
        hasCompleteHumanLabels &&
        unresolvedDisagreements.size === 0 &&
        !blockers.has("HUMAN_LABELS_INVALID") &&
        !blockers.has("INDEPENDENT_RATERS_MISSING");
    if (resolvedHumanTruth &&
        metrics.p0Recall !== null &&
        metrics.p0Recall < policy.p0RecallMinimum) {
        failures.add("P0_RECALL_BELOW_THRESHOLD");
    }
    if (resolvedHumanTruth &&
        metrics.overallAgreement !== null &&
        metrics.overallAgreement < policy.overallAgreementMinimum) {
        failures.add("OVERALL_AGREEMENT_BELOW_THRESHOLD");
    }
    if (resolvedHumanTruth &&
        metrics.cohenKappa !== null &&
        metrics.cohenKappa < policy.cohenKappaMinimum) {
        failures.add("COHEN_KAPPA_BELOW_THRESHOLD");
    }
    if (labels?.status === "COMPLETE" &&
        !hasP0ReferenceLabel(labelsByItem, adjudicationsByItem)) {
        blockers.add("P0_REFERENCE_LABEL_MISSING");
    }
    const hasPendingHumanInput = [...blockers].some((blocker) => [
        "HUMAN_LABELS_MISSING",
        "HUMAN_LABELS_INCOMPLETE",
        "UNRESOLVED_LABEL_DISAGREEMENT",
        "INDEPENDENT_RATERS_MISSING"
    ].includes(blocker));
    const hasInvalidInput = [...blockers].some((blocker) => [
        "AWB_OBSERVATIONS_INVALID",
        "HUMAN_LABELS_INVALID",
        "UNKNOWN_FAILURE_CODE",
        "HARD_FAILURE_CODE_MISSING",
        "INVALID_P0_GATE_SEMANTICS",
        "INVALID_HARD_FAILURE_SEMANTICS"
    ].includes(blocker));
    const status = failures.size > 0
        ? "FAIL"
        : hasInvalidInput
            ? "INSUFFICIENT_EVIDENCE"
            : hasPendingHumanInput
                ? "PENDING_HUMAN_INPUT"
                : blockers.size > 0
                    ? "INSUFFICIENT_EVIDENCE"
                    : "PASS";
    const criterionValidity = status === "PASS"
        ? "established"
        : status === "FAIL"
            ? "failed"
            : status === "PENDING_HUMAN_INPUT"
                ? "pending_human_input"
                : "diagnostic_only";
    const gateEligibility = status === "PASS" ? "ELIGIBLE" : status === "FAIL" ? "BLOCK" : "DIAGNOSTIC_ONLY";
    const bindings = {
        policyHash: sha256Text(stableJson(policy)),
        studyHash: sha256Text(stableJson(study)),
        observationsHash: sha256Text(stableJson(observations
            ? {
                schemaVersion: observations.schemaVersion,
                resultType: observations.resultType,
                studyId: observations.studyId,
                status: observations.status,
                items: observationManifestItems
                    .map((item) => ({
                    itemId: item.itemId,
                    comparisonHash: item.evidence.comparisonHash
                }))
                    .sort((left, right) => left.itemId.localeCompare(right.itemId))
            }
            : null)),
        verifiedEvidenceHash: sha256Text(stableJson([...observedItems]
            .map((item) => ({
            itemId: item.itemId,
            classification: item.classification,
            gateDecision: item.gateDecision,
            failureCodes: sortedCodes(item.failureCodes),
            comparisonHash: item.evidence.comparisonHash,
            attemptFingerprint: item.evidence.attemptFingerprint
        }))
            .sort((left, right) => left.itemId.localeCompare(right.itemId)))),
        humanLabelsHash: sha256Text(stableJson(normalizedLabels ?? null))
    };
    const reportWithoutIntegrity = {
        schemaVersion: "0.1.0",
        resultType: "external_validity_report",
        studyId: study.studyId,
        status,
        criterionValidity,
        strongConclusionAllowed: status === "PASS",
        gateEligibility,
        blockers: [...blockers].sort(),
        failures: [...failures].sort(),
        bindings,
        metrics,
        coverage
    };
    return {
        ...reportWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(reportWithoutIntegrity))
        }
    };
}
export function renderExternalValidityMarkdown(report) {
    const statusLabel = report.status === "PENDING_HUMAN_INPUT"
        ? "Pending human input"
        : report.status
            .toLowerCase()
            .replaceAll("_", " ")
            .replace(/^\w/u, (value) => value.toUpperCase());
    return [
        "# External Criterion Validity Report",
        "",
        `Study: ${report.studyId}`,
        `Status: ${statusLabel}`,
        `Criterion validity: ${report.criterionValidity}`,
        `Strong conclusion allowed: ${report.strongConclusionAllowed}`,
        `Gate eligibility: ${report.gateEligibility}`,
        "",
        "## Evidence",
        `Policy binding: ${report.bindings.policyHash}`,
        `Study binding: ${report.bindings.studyHash}`,
        `Verified evidence binding: ${report.bindings.verifiedEvidenceHash}`,
        `Human-label binding: ${report.bindings.humanLabelsHash}`,
        `Planned: ${report.metrics.sampleSize.planned}`,
        `Observed: ${report.metrics.sampleSize.observed}`,
        `Labeled: ${report.metrics.sampleSize.labeled}`,
        `P0 precision: ${report.metrics.p0Precision ?? "pending"}`,
        `P0 recall: ${report.metrics.p0Recall ?? "pending"}`,
        `False PASS: ${report.metrics.falsePassCount ?? "pending"}`,
        `Overall agreement: ${report.metrics.overallAgreement ?? "pending"}`,
        `Cohen kappa: ${report.metrics.cohenKappa ?? "pending"}`,
        "",
        "## Blockers",
        ...(report.blockers.length > 0
            ? report.blockers.map((blocker) => `- ${blocker}`)
            : ["- none"]),
        "",
        "## Failures",
        ...(report.failures.length > 0
            ? report.failures.map((failure) => `- ${failure}`)
            : ["- none"])
    ].join("\n");
}
function analyzeCoverage(study, policy) {
    const targetById = new Map(study.targets.map((target) => [target.targetId, target]));
    const targetClasses = [...new Set(study.targets.map((target) => target.targetClass))].sort();
    const runners = [...new Set(study.items.map((item) => item.runner))].sort();
    const cells = new Map();
    for (const item of study.items) {
        const target = targetById.get(item.targetId);
        if (!target) {
            continue;
        }
        const key = [target.targetClass, item.runner, item.designStratum].join("\0");
        cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    const expectedCells = policy.requiredTargetClasses.length *
        policy.requiredRunners.length *
        policy.requiredDesignStrata.length;
    const requiredCellsComplete = policy.requiredTargetClasses.every((targetClass) => policy.requiredRunners.every((runner) => policy.requiredDesignStrata.every((stratum) => (cells.get([targetClass, runner, stratum].join("\0")) ?? 0) >=
        policy.minimumItemsPerCell)));
    return {
        targetClasses,
        runners,
        designCells: cells.size,
        minimumItemsPerCell: policy.minimumItemsPerCell,
        complete: cells.size === expectedCells &&
            requiredCellsComplete &&
            study.items.length >= policy.minimumTotalItems
    };
}
function calculateMetrics(study, observationsByItem, labelsByItem, adjudicationsByItem) {
    const resolvedLabels = new Map();
    for (const item of study.items) {
        const resolved = resolveHumanLabel(labelsByItem.get(item.itemId) ?? [], adjudicationsByItem.get(item.itemId));
        if (resolved) {
            resolvedLabels.set(item.itemId, resolved);
        }
    }
    const matrixCounts = new Map();
    let comparable = 0;
    let exactMatches = 0;
    let trueP0 = 0;
    let observedP0 = 0;
    let correctP0 = 0;
    let falsePassCount = 0;
    for (const item of study.items) {
        const expected = resolvedLabels.get(item.itemId);
        const observed = observationsByItem.get(item.itemId);
        if (!expected || !observed) {
            continue;
        }
        comparable += 1;
        const key = matrixKey(expected.classification, observed.classification);
        matrixCounts.set(key, (matrixCounts.get(key) ?? 0) + 1);
        if (sameDecision(expected, observed)) {
            exactMatches += 1;
        }
        const expectedP0 = isP0HardFailure(expected);
        const observedP0Result = isP0HardFailure(observed);
        if (expectedP0) {
            trueP0 += 1;
            if (observed.gateDecision === "PASS") {
                falsePassCount += 1;
            }
        }
        if (observedP0Result) {
            observedP0 += 1;
        }
        if (expectedP0 && observedP0Result) {
            correctP0 += 1;
        }
    }
    return {
        sampleSize: {
            planned: study.items.length,
            observed: observationsByItem.size,
            labeled: new Set([...labelsByItem].filter(([, itemLabels]) => itemLabels.length > 0).map(([itemId]) => itemId)).size,
            adjudicated: adjudicationsByItem.size
        },
        confusionMatrix: buildConfusionMatrix(matrixCounts),
        p0Precision: observedP0 === 0 ? (trueP0 === 0 && comparable > 0 ? 1 : null) : correctP0 / observedP0,
        p0Recall: trueP0 === 0 ? (comparable > 0 ? 1 : null) : correctP0 / trueP0,
        falsePassCount: comparable === 0 ? null : falsePassCount,
        overallAgreement: comparable === 0 ? null : exactMatches / comparable,
        interRaterAgreement: interRaterAgreement(labelsByItem),
        cohenKappa: cohenKappa(labelsByItem)
    };
}
function buildConfusionMatrix(counts) {
    const output = [];
    for (const expected of CLASSIFICATIONS) {
        for (const observed of CLASSIFICATIONS) {
            const count = counts.get(matrixKey(expected, observed)) ?? 0;
            if (count > 0) {
                output.push({ expected, observed, count });
            }
        }
    }
    return output;
}
function groupByItem(labels) {
    const grouped = new Map();
    for (const label of labels) {
        const existing = grouped.get(label.itemId) ?? [];
        existing.push(label);
        grouped.set(label.itemId, existing);
    }
    return grouped;
}
function findUnresolvedDisagreements(labelsByItem, adjudicationsByItem) {
    const output = new Set();
    for (const [itemId, itemLabels] of labelsByItem) {
        if (itemLabels.length >= 2 && !labelsAgree(itemLabels) && !adjudicationsByItem.has(itemId)) {
            output.add(itemId);
        }
    }
    return output;
}
function resolveHumanLabel(itemLabels, adjudication) {
    if (itemLabels.length >= 2 && labelsAgree(itemLabels)) {
        return itemLabels[0];
    }
    if (adjudication) {
        return { ...adjudication, raterId: adjudication.adjudicatorId };
    }
    return undefined;
}
function labelsAgree(labels) {
    const [first] = labels;
    return Boolean(first) && labels.every((label) => sameDecision(first, label));
}
function sameDecision(left, right) {
    return (left.classification === right.classification &&
        left.gateDecision === right.gateDecision &&
        sortedCodes(left.failureCodes).join("\0") === sortedCodes(right.failureCodes).join("\0"));
}
function hasQualifiedLiveTrace(item) {
    return (isSha256(item.evidence.comparisonHash) &&
        isSha256(item.evidence.attemptFingerprint));
}
function isP0HardFailure(item) {
    return item.failureCodes.some((code) => getHardFailureDefinition(code)?.severity === "P0");
}
function interRaterAgreement(labelsByItem) {
    const pairs = comparableRaterPairs(labelsByItem);
    if (pairs.length === 0) {
        return null;
    }
    return pairs.filter(([left, right]) => sameDecision(left, right)).length / pairs.length;
}
function cohenKappa(labelsByItem) {
    const pairs = comparableRaterPairs(labelsByItem);
    if (pairs.length === 0) {
        return null;
    }
    const observed = pairs.filter(([left, right]) => left.classification === right.classification).length / pairs.length;
    const leftCounts = countClassifications(pairs.map(([left]) => left.classification));
    const rightCounts = countClassifications(pairs.map(([, right]) => right.classification));
    const expected = CLASSIFICATIONS.reduce((sum, classification) => sum +
        ((leftCounts.get(classification) ?? 0) / pairs.length) *
            ((rightCounts.get(classification) ?? 0) / pairs.length), 0);
    if (expected === 1) {
        return observed === 1 ? 1 : 0;
    }
    return (observed - expected) / (1 - expected);
}
function comparableRaterPairs(labelsByItem) {
    const output = [];
    for (const itemLabels of labelsByItem.values()) {
        const distinct = [...new Map(itemLabels.map((label) => [label.raterId, label])).values()].sort((left, right) => left.raterId.localeCompare(right.raterId));
        if (distinct.length >= 2) {
            output.push([distinct[0], distinct[1]]);
        }
    }
    return output;
}
function countClassifications(values) {
    const counts = new Map();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
}
function matrixKey(expected, observed) {
    return `${expected}\0${observed}`;
}
function sortedCodes(codes) {
    return [...new Set(codes)].sort();
}
function buildItemIdAliases(study) {
    return new Map(study.items.flatMap((item) => [
        [item.itemId, item.itemId],
        [item.blindedChangeId, item.itemId]
    ]));
}
function containsDuplicateHumanLabels(labels) {
    const identities = labels.map((label) => `${label.itemId}\0${label.raterId}`);
    return new Set(identities).size !== identities.length;
}
function isValidObservationManifestItem(item) {
    return (stableJson(Object.keys(item).sort()) ===
        stableJson(["evidence", "itemId"]) &&
        isSemanticId(item.itemId) &&
        Boolean(item.evidence) &&
        stableJson(Object.keys(item.evidence).sort()) ===
            stableJson(["comparisonHash", "comparisonRef"]) &&
        typeof item.evidence.comparisonRef === "string" &&
        item.evidence.comparisonRef.length > 0 &&
        item.evidence.comparisonRef.length <= 1024 &&
        !item.evidence.comparisonRef.includes("\0") &&
        isSha256(item.evidence.comparisonHash));
}
function isValidDecisionRecord(item) {
    return (CLASSIFICATIONS.includes(item.classification) &&
        GATE_DECISIONS.includes(item.gateDecision) &&
        Array.isArray(item.failureCodes) &&
        item.failureCodes.every((code) => typeof code === "string" &&
            /^[A-Z0-9][A-Z0-9_-]{0,127}$/u.test(code)) &&
        new Set(item.failureCodes).size === item.failureCodes.length);
}
function hasUnknownFailureCode(item) {
    return (!Array.isArray(item.failureCodes) ||
        item.failureCodes.some((code) => getHardFailureDefinition(code) === undefined));
}
function hasMissingHardFailureCode(item) {
    return (item.classification === "HARD_FAILURE" &&
        (!Array.isArray(item.failureCodes) ||
            !item.failureCodes.some((code) => getHardFailureDefinition(code) !== undefined)));
}
function hasInvalidP0GateSemantics(item) {
    const hasP0 = Array.isArray(item.failureCodes) &&
        item.failureCodes.some((code) => getHardFailureDefinition(code)?.severity === "P0");
    return (hasP0 &&
        (item.classification !== "HARD_FAILURE" || item.gateDecision !== "BLOCK"));
}
function hasInvalidHardFailureSemantics(item) {
    const hasRegisteredHardFailure = Array.isArray(item.failureCodes) &&
        item.failureCodes.some((code) => getHardFailureDefinition(code) !== undefined);
    return (hasRegisteredHardFailure &&
        (item.classification !== "HARD_FAILURE" || item.gateDecision !== "BLOCK"));
}
function assertExternalValidityStudy(study) {
    if (study.schemaVersion !== "0.1.0" ||
        study.resultType !== "external_validity_study" ||
        study.protocolVersion !== "criterion-validity-v1" ||
        study.blinding.mode !== "double_blind" ||
        !isSha256(study.blinding.assignmentHash) ||
        study.targets.length === 0 ||
        study.items.length === 0) {
        throw new Error("External validity study is missing required protocol fields.");
    }
    if (!allUnique(study.targets.map((target) => target.targetId)) ||
        !allUnique(study.targets.map((target) => target.blindedTargetId)) ||
        !allUnique(study.items.map((item) => item.itemId)) ||
        !allUnique(study.items.map((item) => item.blindedChangeId)) ||
        !allUnique(study.items.flatMap((item) => [item.itemId, item.blindedChangeId]))) {
        throw new Error("External validity study contains duplicate semantic identities.");
    }
    const targetsById = new Map(study.targets.map((target) => [target.targetId, target]));
    if (study.targets.some((target) => !isSemanticId(target.targetId) ||
        !isSemanticId(target.blindedTargetId) ||
        !TARGET_CLASSES.includes(target.targetClass) ||
        !isSha256(target.targetRefHash) ||
        !isSha256(target.contractHash) ||
        !["reviewed", "pending_human_input"].includes(target.contractReview.status) ||
        (target.contractReview.status === "reviewed" &&
            !isSha256(target.contractReview.artifactHash))) ||
        study.items.some((item) => !isSemanticId(item.itemId) ||
            !isSemanticId(item.blindedChangeId) ||
            !targetsById.has(item.targetId) ||
            !RUNNERS.includes(item.runner) ||
            !DESIGN_STRATA.includes(item.designStratum) ||
            item.runnerBlindId === item.runner ||
            !isSemanticId(item.runnerBlindId) ||
            !isSha256(item.baseline.contentHash) ||
            !isSha256(item.candidate.contentHash))) {
        throw new Error("External validity study contains invalid public metadata.");
    }
    const refs = study.items.flatMap((item) => [item.baseline.ref, item.candidate.ref]);
    if (!refs.every(isPublicSafeRef)) {
        throw new Error("External validity labeling requires public-safe external artifact references.");
    }
}
function hasIndependentRaters(labels, minimum) {
    const ids = labels.raters.map((rater) => rater.raterId);
    const roles = new Set(labels.raters.map((rater) => rater.role));
    return (labels.raters.length === minimum &&
        new Set(ids).size === minimum &&
        ids.every(isSemanticId) &&
        roles.has("workflow_owner") &&
        roles.has("independent_reviewer") &&
        labels.labels.every((label) => ids.includes(label.raterId)) &&
        labels.adjudications.every((item) => isSemanticId(item.adjudicatorId) &&
            !ids.includes(item.adjudicatorId)));
}
function containsDuplicateEvidence(items) {
    const comparisonHashes = items.map((item) => item.evidence.comparisonHash);
    const attemptFingerprints = items.map((item) => item.evidence.attemptFingerprint);
    return (new Set(comparisonHashes).size !== comparisonHashes.length ||
        new Set(attemptFingerprints).size !== attemptFingerprints.length);
}
function containsDuplicateObservationManifests(items) {
    const comparisonHashes = items.map((item) => item.evidence.comparisonHash);
    const comparisonRefs = items.map((item) => item.evidence.comparisonRef);
    return (new Set(comparisonHashes).size !== comparisonHashes.length ||
        new Set(comparisonRefs).size !== comparisonRefs.length);
}
function hasP0ReferenceLabel(labelsByItem, adjudicationsByItem) {
    for (const [itemId, labels] of labelsByItem) {
        const resolved = resolveHumanLabel(labels, adjudicationsByItem.get(itemId));
        if (resolved && isP0HardFailure(resolved)) {
            return true;
        }
    }
    return false;
}
function isPublicSafeRef(ref) {
    return (/^(?:external|https|ipfs):\/\//u.test(ref) &&
        !/(?:\/Users\/|\/home\/|\/private\/|@|private-target|company-domain)/iu.test(ref));
}
function publicArtifactRef(artifact) {
    return {
        ref: `external://artifact/${artifact.contentHash.replace("sha256:", "")}`,
        contentHash: artifact.contentHash
    };
}
function isSha256(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
function isSemanticId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
function allUnique(values) {
    return new Set(values).size === values.length;
}
