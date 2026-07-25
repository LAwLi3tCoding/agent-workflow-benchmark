import {
  getCriterionValidityPolicy,
  getHardFailureDefinition
} from "../evaluation/evaluationContract.js";
import type { ObserverTrustOptions } from "../regression/compare.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { verifyExternalValidityComparisonEvidence } from "./comparisonEvidence.js";

export type ExternalValidityTargetClass = "directory" | "cli" | "hybrid";
export type ExternalValidityRunner = "codex" | "claude";
export type ExternalValidityDesignStratum =
  | "known_improvement"
  | "no_change"
  | "ordinary_regression"
  | "p0_regression";
export type ExternalValidityClassification =
  | "IMPROVED"
  | "UNCHANGED"
  | "REGRESSED"
  | "MIXED"
  | "HARD_FAILURE"
  | "INCOMPARABLE";
export type ExternalValidityGateDecision =
  | "PASS"
  | "BLOCK"
  | "DIAGNOSTIC_ONLY";

export interface ExternalValidityArtifactRef {
  ref: string;
  contentHash: string;
}

export interface ExternalValidityStudy {
  schemaVersion: "0.1.0";
  resultType: "external_validity_study";
  studyId: string;
  protocolVersion: "criterion-validity-v1";
  blinding: {
    mode: "double_blind";
    assignmentHash: string;
  };
  targets: Array<{
    targetId: string;
    blindedTargetId: string;
    targetClass: ExternalValidityTargetClass;
    targetRefHash: string;
    contractHash: string;
    contractReview: {
      status: "reviewed" | "pending_human_input";
      artifactHash?: string;
    };
  }>;
  items: Array<{
    itemId: string;
    blindedChangeId: string;
    targetId: string;
    runner: ExternalValidityRunner;
    runnerBlindId: string;
    designStratum: ExternalValidityDesignStratum;
    baseline: ExternalValidityArtifactRef;
    candidate: ExternalValidityArtifactRef;
  }>;
}

export interface ExternalValidityObservationSet {
  schemaVersion: "0.1.0";
  resultType: "external_validity_observations";
  studyId: string;
  status: "DRAFT" | "COMPLETE";
  items: Array<{
    itemId: string;
    evidence: {
      comparisonRef: string;
      comparisonHash: string;
    };
  }>;
}

interface VerifiedExternalValidityObservation {
  itemId: string;
  classification: ExternalValidityClassification;
  gateDecision: ExternalValidityGateDecision;
  failureCodes: string[];
  evidence: {
    comparisonHash: string;
    attemptFingerprint: string;
  };
}

const VERIFIED_OBSERVATIONS = Symbol("verified-external-validity-observations");

type VerifiedObservationSet = ExternalValidityObservationSet & {
  [VERIFIED_OBSERVATIONS]: Map<string, VerifiedExternalValidityObservation>;
};

export interface ExternalValidityHumanLabels {
  schemaVersion: "0.1.0";
  resultType: "external_validity_human_labels";
  studyId: string;
  status: "DRAFT" | "COMPLETE";
  blindingAttestation?: "awb_decision_hidden" | string;
  raters: Array<{
    raterId: string;
    role: "workflow_owner" | "independent_reviewer" | string;
  }>;
  labels: Array<{
    itemId: string;
    raterId: string;
    classification: ExternalValidityClassification;
    gateDecision: ExternalValidityGateDecision;
    failureCodes: string[];
  }>;
  adjudications: Array<{
    itemId: string;
    adjudicatorId: string;
    classification: ExternalValidityClassification;
    gateDecision: ExternalValidityGateDecision;
    failureCodes: string[];
    resolution: string;
  }>;
}

export interface ExternalValidityReport {
  schemaVersion: "0.1.0";
  resultType: "external_validity_report";
  studyId: string;
  status: "PASS" | "FAIL" | "PENDING_HUMAN_INPUT" | "INSUFFICIENT_EVIDENCE";
  criterionValidity: "established" | "pending_human_input" | "diagnostic_only" | "failed";
  strongConclusionAllowed: boolean;
  gateEligibility: "ELIGIBLE" | "BLOCK" | "DIAGNOSTIC_ONLY";
  blockers: string[];
  failures: string[];
  bindings: {
    policyHash: string;
    studyHash: string;
    observationsHash: string;
    verifiedEvidenceHash: string;
    humanLabelsHash: string;
  };
  metrics: {
    sampleSize: {
      planned: number;
      observed: number;
      labeled: number;
      adjudicated: number;
    };
    confusionMatrix: Array<{
      expected: ExternalValidityClassification;
      observed: ExternalValidityClassification;
      count: number;
    }>;
    p0Precision: number | null;
    p0Recall: number | null;
    falsePassCount: number | null;
    overallAgreement: number | null;
    interRaterAgreement: number | null;
    cohenKappa: number | null;
  };
  coverage: {
    targetClasses: ExternalValidityTargetClass[];
    runners: string[];
    designCells: number;
    minimumItemsPerCell: number;
    complete: boolean;
  };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export interface ExternalValidityLabelingPackage {
  package: {
    schemaVersion: "0.1.0";
    resultType: "external_validity_labeling_package";
    studyId: string;
    status: "READY_FOR_HUMAN_LABELING";
    publicSafe: true;
    blinding: ExternalValidityStudy["blinding"];
    items: Array<{
      itemId: string;
      blindedChangeId: string;
      blindedTargetId: string;
      targetClass: ExternalValidityTargetClass;
      runnerBlindId: string;
      baseline: ExternalValidityArtifactRef;
      candidate: ExternalValidityArtifactRef;
    }>;
  };
  labelsTemplate: Pick<
    ExternalValidityHumanLabels,
    "schemaVersion" | "resultType" | "studyId" | "status" | "raters" | "labels" | "adjudications"
  >;
  observationsTemplate: Pick<
    ExternalValidityObservationSet,
    "schemaVersion" | "resultType" | "studyId" | "status" | "items"
  >;
}

const CLASSIFICATIONS: ExternalValidityClassification[] = [
  "IMPROVED",
  "UNCHANGED",
  "REGRESSED",
  "MIXED",
  "HARD_FAILURE",
  "INCOMPARABLE"
];
const GATE_DECISIONS: ExternalValidityGateDecision[] = [
  "PASS",
  "BLOCK",
  "DIAGNOSTIC_ONLY"
];
const TARGET_CLASSES: ExternalValidityTargetClass[] = [
  "directory",
  "cli",
  "hybrid"
];
const RUNNERS: ExternalValidityRunner[] = ["codex", "claude"];
const DESIGN_STRATA: ExternalValidityDesignStratum[] = [
  "known_improvement",
  "no_change",
  "ordinary_regression",
  "p0_regression"
];

export function createExternalValidityLabelingPackage(
  study: ExternalValidityStudy
): ExternalValidityLabelingPackage {
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

async function verifyExternalValidityObservations(
  study: ExternalValidityStudy,
  observations: ExternalValidityObservationSet,
  options: ObserverTrustOptions
): Promise<ExternalValidityObservationSet> {
  assertExternalValidityStudy(study);
  const aliases = buildItemIdAliases(study);
  const studyItems = new Map(study.items.map((item) => [item.itemId, item]));
  const targets = new Map(study.targets.map((target) => [target.targetId, target]));
  const verified = new Map<string, VerifiedExternalValidityObservation>();

  await Promise.all(
    observations.items.map(async (manifestItem) => {
      const itemId = aliases.get(manifestItem.itemId) ?? manifestItem.itemId;
      const studyItem = studyItems.get(itemId);
      const target = studyItem ? targets.get(studyItem.targetId) : undefined;
      if (!studyItem || !target) {
        return;
      }
      const result = await verifyExternalValidityComparisonEvidence(
        manifestItem.evidence.comparisonRef,
        options
      );
      if (
        result.status !== "VALID" ||
        result.evidence.comparisonHash !==
          manifestItem.evidence.comparisonHash ||
        result.evidence.targetIdHash !== target.targetRefHash ||
        result.evidence.contractHash !== target.contractHash ||
        result.evidence.runner !== studyItem.runner ||
        result.evidence.baselineContentHash !==
          studyItem.baseline.contentHash ||
        result.evidence.candidateContentHash !==
          studyItem.candidate.contentHash
      ) {
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
    })
  );

  const output = {
    ...observations,
    items: observations.items.map((item) => ({ ...item }))
  } as VerifiedObservationSet;
  Object.defineProperty(output, VERIFIED_OBSERVATIONS, {
    value: verified,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return output;
}

export async function analyzeExternalValidityFromComparisons(
  study: ExternalValidityStudy,
  observations: ExternalValidityObservationSet,
  labels: ExternalValidityHumanLabels | undefined,
  options: ObserverTrustOptions
): Promise<ExternalValidityReport> {
  return analyzeExternalValidity(
    study,
    await verifyExternalValidityObservations(study, observations, options),
    labels
  );
}

export function analyzeExternalValidity(
  study: ExternalValidityStudy,
  observations?: ExternalValidityObservationSet,
  labels?: ExternalValidityHumanLabels
): ExternalValidityReport {
  assertExternalValidityStudy(study);
  const policy = getCriterionValidityPolicy();
  const coverage = analyzeCoverage(study, policy);
  const blockers = new Set<string>();
  const failures = new Set<string>();
  const rawObservedItems = observations?.items ?? [];
  const verifiedObservations =
    observations && VERIFIED_OBSERVATIONS in observations
      ? (observations as VerifiedObservationSet)[VERIFIED_OBSERVATIONS]
      : new Map<string, VerifiedExternalValidityObservation>();
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
  const observationManifestByItem = new Map(
    observationManifestItems.map((item) => [item.itemId, item])
  );
  const observationsByItem = new Map(
    observedItems.map((item) => [item.itemId, item])
  );
  const labelsByItem = groupByItem(humanLabels);
  const adjudicationsByItem = new Map(adjudications.map((item) => [item.itemId, item]));
  const studyItemIds = new Set(study.items.map((item) => item.itemId));
  const humanDecisions = [...humanLabels, ...adjudications];
  const humanDecisionsValid = humanDecisions.every(isValidDecisionRecord);
  if (
    observations &&
    (observations.schemaVersion !== "0.1.0" ||
      observations.resultType !== "external_validity_observations" ||
      !["DRAFT", "COMPLETE"].includes(observations.status) ||
      observations.studyId !== study.studyId ||
      observationManifestByItem.size !== observationManifestItems.length ||
      observationManifestItems.some(
        (item) =>
          !studyItemIds.has(item.itemId) ||
          !isValidObservationManifestItem(item)
      ))
  ) {
    blockers.add("AWB_OBSERVATIONS_INVALID");
  }
  if (
    normalizedLabels &&
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
        return (
          itemLabels.length !== policy.minimumIndependentRaters ||
          labelsAgree(itemLabels)
        );
      }))
  ) {
    blockers.add("HUMAN_LABELS_INVALID");
  }
  if (
    normalizedLabels &&
    !hasIndependentRaters(normalizedLabels, policy.minimumIndependentRaters)
  ) {
    blockers.add("INDEPENDENT_RATERS_MISSING");
  }
  const hasCompleteObservedItems =
    observedItems.length === study.items.length &&
    study.items.every((item) => observationsByItem.has(item.itemId));
  const hasCompleteHumanLabels =
    study.items.length > 0 &&
    study.items.every(
      (item) =>
        new Set(
          (labelsByItem.get(item.itemId) ?? []).map((label) => label.raterId)
        ).size === policy.minimumIndependentRaters
    );

  if (observations && !hasCompleteObservedItems) {
    blockers.add("AWB_OBSERVATIONS_INCOMPLETE");
  }
  if (labels && !hasCompleteHumanLabels) {
    blockers.add("HUMAN_LABELS_INCOMPLETE");
  }
  if (
    observations &&
    (verifiedObservations.size !== observationManifestItems.length ||
      observedItems.some((item) => !hasQualifiedLiveTrace(item)))
  ) {
    blockers.add("UNQUALIFIED_EVIDENCE");
  }
  if (
    observations &&
    (containsDuplicateObservationManifests(observationManifestItems) ||
      containsDuplicateEvidence(observedItems))
  ) {
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
  if (
    metrics.falsePassCount !== null &&
    metrics.falsePassCount > policy.maximumFalsePassCount
  ) {
    failures.add("FALSE_PASS_DETECTED");
  }
  const resolvedHumanTruth =
    labels?.status === "COMPLETE" &&
    hasCompleteHumanLabels &&
    unresolvedDisagreements.size === 0 &&
    !blockers.has("HUMAN_LABELS_INVALID") &&
    !blockers.has("INDEPENDENT_RATERS_MISSING");
  if (
    resolvedHumanTruth &&
    metrics.p0Recall !== null &&
    metrics.p0Recall < policy.p0RecallMinimum
  ) {
    failures.add("P0_RECALL_BELOW_THRESHOLD");
  }
  if (
    resolvedHumanTruth &&
    metrics.overallAgreement !== null &&
    metrics.overallAgreement < policy.overallAgreementMinimum
  ) {
    failures.add("OVERALL_AGREEMENT_BELOW_THRESHOLD");
  }
  if (
    resolvedHumanTruth &&
    metrics.cohenKappa !== null &&
    metrics.cohenKappa < policy.cohenKappaMinimum
  ) {
    failures.add("COHEN_KAPPA_BELOW_THRESHOLD");
  }
  if (
    labels?.status === "COMPLETE" &&
    !hasP0ReferenceLabel(labelsByItem, adjudicationsByItem)
  ) {
    blockers.add("P0_REFERENCE_LABEL_MISSING");
  }

  const hasPendingHumanInput = [...blockers].some((blocker) =>
    [
      "HUMAN_LABELS_MISSING",
      "HUMAN_LABELS_INCOMPLETE",
      "UNRESOLVED_LABEL_DISAGREEMENT",
      "INDEPENDENT_RATERS_MISSING"
    ].includes(blocker)
  );
  const hasInvalidInput = [...blockers].some((blocker) =>
    [
      "AWB_OBSERVATIONS_INVALID",
      "HUMAN_LABELS_INVALID",
      "UNKNOWN_FAILURE_CODE",
      "HARD_FAILURE_CODE_MISSING",
      "INVALID_P0_GATE_SEMANTICS",
      "INVALID_HARD_FAILURE_SEMANTICS"
    ].includes(blocker)
  );
  const status: ExternalValidityReport["status"] =
    failures.size > 0
      ? "FAIL"
      : hasInvalidInput
        ? "INSUFFICIENT_EVIDENCE"
        : hasPendingHumanInput
          ? "PENDING_HUMAN_INPUT"
          : blockers.size > 0
            ? "INSUFFICIENT_EVIDENCE"
            : "PASS";
  const criterionValidity: ExternalValidityReport["criterionValidity"] =
    status === "PASS"
      ? "established"
      : status === "FAIL"
        ? "failed"
        : status === "PENDING_HUMAN_INPUT"
          ? "pending_human_input"
          : "diagnostic_only";
  const gateEligibility: ExternalValidityReport["gateEligibility"] =
    status === "PASS" ? "ELIGIBLE" : status === "FAIL" ? "BLOCK" : "DIAGNOSTIC_ONLY";
  const bindings: ExternalValidityReport["bindings"] = {
    policyHash: sha256Text(stableJson(policy)),
    studyHash: sha256Text(stableJson(study)),
    observationsHash: sha256Text(
      stableJson(
        observations
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
                .sort((left, right) =>
                  left.itemId.localeCompare(right.itemId)
                )
            }
          : null
      )
    ),
    verifiedEvidenceHash: sha256Text(
      stableJson(
        [...observedItems]
          .map((item) => ({
            itemId: item.itemId,
            classification: item.classification,
            gateDecision: item.gateDecision,
            failureCodes: sortedCodes(item.failureCodes),
            comparisonHash: item.evidence.comparisonHash,
            attemptFingerprint: item.evidence.attemptFingerprint
          }))
          .sort((left, right) => left.itemId.localeCompare(right.itemId))
      )
    ),
    humanLabelsHash: sha256Text(
      stableJson(normalizedLabels ?? null)
    )
  };
  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    resultType: "external_validity_report" as const,
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

export function renderExternalValidityMarkdown(
  report: ExternalValidityReport
): string {
  const statusLabel =
    report.status === "PENDING_HUMAN_INPUT"
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

function analyzeCoverage(
  study: ExternalValidityStudy,
  policy: ReturnType<typeof getCriterionValidityPolicy>
): ExternalValidityReport["coverage"] {
  const targetById = new Map(study.targets.map((target) => [target.targetId, target]));
  const targetClasses = [...new Set(study.targets.map((target) => target.targetClass))].sort();
  const runners = [...new Set(study.items.map((item) => item.runner))].sort();
  const cells = new Map<string, number>();
  for (const item of study.items) {
    const target = targetById.get(item.targetId);
    if (!target) {
      continue;
    }
    const key = [target.targetClass, item.runner, item.designStratum].join("\0");
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const expectedCells =
    policy.requiredTargetClasses.length *
    policy.requiredRunners.length *
    policy.requiredDesignStrata.length;
  const requiredCellsComplete = policy.requiredTargetClasses.every(
    (targetClass) =>
      policy.requiredRunners.every((runner) =>
        policy.requiredDesignStrata.every(
          (stratum) =>
            (cells.get([targetClass, runner, stratum].join("\0")) ?? 0) >=
            policy.minimumItemsPerCell
        )
      )
  );
  return {
    targetClasses,
    runners,
    designCells: cells.size,
    minimumItemsPerCell: policy.minimumItemsPerCell,
    complete:
      cells.size === expectedCells &&
      requiredCellsComplete &&
      study.items.length >= policy.minimumTotalItems
  };
}

function calculateMetrics(
  study: ExternalValidityStudy,
  observationsByItem: Map<string, VerifiedExternalValidityObservation>,
  labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>,
  adjudicationsByItem: Map<string, ExternalValidityHumanLabels["adjudications"][number]>
): ExternalValidityReport["metrics"] {
  const resolvedLabels = new Map<string, ExternalValidityHumanLabels["labels"][number]>();
  for (const item of study.items) {
    const resolved = resolveHumanLabel(labelsByItem.get(item.itemId) ?? [], adjudicationsByItem.get(item.itemId));
    if (resolved) {
      resolvedLabels.set(item.itemId, resolved);
    }
  }

  const matrixCounts = new Map<string, number>();
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

function buildConfusionMatrix(
  counts: Map<string, number>
): ExternalValidityReport["metrics"]["confusionMatrix"] {
  const output: ExternalValidityReport["metrics"]["confusionMatrix"] = [];
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

function groupByItem(
  labels: ExternalValidityHumanLabels["labels"]
): Map<string, ExternalValidityHumanLabels["labels"]> {
  const grouped = new Map<string, ExternalValidityHumanLabels["labels"]>();
  for (const label of labels) {
    const existing = grouped.get(label.itemId) ?? [];
    existing.push(label);
    grouped.set(label.itemId, existing);
  }
  return grouped;
}

function findUnresolvedDisagreements(
  labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>,
  adjudicationsByItem: Map<string, ExternalValidityHumanLabels["adjudications"][number]>
): Set<string> {
  const output = new Set<string>();
  for (const [itemId, itemLabels] of labelsByItem) {
    if (itemLabels.length >= 2 && !labelsAgree(itemLabels) && !adjudicationsByItem.has(itemId)) {
      output.add(itemId);
    }
  }
  return output;
}

function resolveHumanLabel(
  itemLabels: ExternalValidityHumanLabels["labels"],
  adjudication: ExternalValidityHumanLabels["adjudications"][number] | undefined
): ExternalValidityHumanLabels["labels"][number] | undefined {
  if (itemLabels.length >= 2 && labelsAgree(itemLabels)) {
    return itemLabels[0];
  }
  if (adjudication) {
    return { ...adjudication, raterId: adjudication.adjudicatorId };
  }
  return undefined;
}

function labelsAgree(labels: ExternalValidityHumanLabels["labels"]): boolean {
  const [first] = labels;
  return Boolean(first) && labels.every((label) => sameDecision(first, label));
}

function sameDecision(
  left: {
    classification: ExternalValidityClassification;
    gateDecision: ExternalValidityGateDecision;
    failureCodes: string[];
  },
  right: {
    classification: ExternalValidityClassification;
    gateDecision: ExternalValidityGateDecision;
    failureCodes: string[];
  }
): boolean {
  return (
    left.classification === right.classification &&
    left.gateDecision === right.gateDecision &&
    sortedCodes(left.failureCodes).join("\0") === sortedCodes(right.failureCodes).join("\0")
  );
}

function hasQualifiedLiveTrace(
  item: VerifiedExternalValidityObservation
): boolean {
  return (
    isSha256(item.evidence.comparisonHash) &&
    isSha256(item.evidence.attemptFingerprint)
  );
}

function isP0HardFailure(item: {
  classification: ExternalValidityClassification;
  failureCodes: string[];
}): boolean {
  return item.failureCodes.some(
    (code) => getHardFailureDefinition(code)?.severity === "P0"
  );
}

function interRaterAgreement(labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>): number | null {
  const pairs = comparableRaterPairs(labelsByItem);
  if (pairs.length === 0) {
    return null;
  }
  return pairs.filter(([left, right]) => sameDecision(left, right)).length / pairs.length;
}

function cohenKappa(labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>): number | null {
  const pairs = comparableRaterPairs(labelsByItem);
  if (pairs.length === 0) {
    return null;
  }
  const observed = pairs.filter(([left, right]) => left.classification === right.classification).length / pairs.length;
  const leftCounts = countClassifications(pairs.map(([left]) => left.classification));
  const rightCounts = countClassifications(pairs.map(([, right]) => right.classification));
  const expected = CLASSIFICATIONS.reduce(
    (sum, classification) =>
      sum +
      ((leftCounts.get(classification) ?? 0) / pairs.length) *
        ((rightCounts.get(classification) ?? 0) / pairs.length),
    0
  );
  if (expected === 1) {
    return observed === 1 ? 1 : 0;
  }
  return (observed - expected) / (1 - expected);
}

function comparableRaterPairs(
  labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>
): Array<[ExternalValidityHumanLabels["labels"][number], ExternalValidityHumanLabels["labels"][number]]> {
  const output: Array<[ExternalValidityHumanLabels["labels"][number], ExternalValidityHumanLabels["labels"][number]]> = [];
  for (const itemLabels of labelsByItem.values()) {
    const distinct = [...new Map(itemLabels.map((label) => [label.raterId, label])).values()].sort((left, right) =>
      left.raterId.localeCompare(right.raterId)
    );
    if (distinct.length >= 2) {
      output.push([distinct[0], distinct[1]]);
    }
  }
  return output;
}

function countClassifications(values: ExternalValidityClassification[]): Map<ExternalValidityClassification, number> {
  const counts = new Map<ExternalValidityClassification, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function matrixKey(
  expected: ExternalValidityClassification,
  observed: ExternalValidityClassification
): string {
  return `${expected}\0${observed}`;
}

function sortedCodes(codes: string[]): string[] {
  return [...new Set(codes)].sort();
}

function buildItemIdAliases(study: ExternalValidityStudy): Map<string, string> {
  return new Map(
    study.items.flatMap((item) => [
      [item.itemId, item.itemId] as const,
      [item.blindedChangeId, item.itemId] as const
    ])
  );
}

function containsDuplicateHumanLabels(
  labels: ExternalValidityHumanLabels["labels"]
): boolean {
  const identities = labels.map(
    (label) => `${label.itemId}\0${label.raterId}`
  );
  return new Set(identities).size !== identities.length;
}

function isValidObservationManifestItem(
  item: ExternalValidityObservationSet["items"][number]
): boolean {
  return (
    stableJson(Object.keys(item).sort()) ===
      stableJson(["evidence", "itemId"]) &&
    isSemanticId(item.itemId) &&
    Boolean(item.evidence) &&
    stableJson(Object.keys(item.evidence).sort()) ===
      stableJson(["comparisonHash", "comparisonRef"]) &&
    typeof item.evidence.comparisonRef === "string" &&
    item.evidence.comparisonRef.length > 0 &&
    item.evidence.comparisonRef.length <= 1024 &&
    !item.evidence.comparisonRef.includes("\0") &&
    isSha256(item.evidence.comparisonHash)
  );
}

function isValidDecisionRecord(item: {
  classification: ExternalValidityClassification;
  gateDecision: ExternalValidityGateDecision;
  failureCodes: string[];
}): boolean {
  return (
    CLASSIFICATIONS.includes(item.classification) &&
    GATE_DECISIONS.includes(item.gateDecision) &&
    Array.isArray(item.failureCodes) &&
    item.failureCodes.every(
      (code) =>
        typeof code === "string" &&
        /^[A-Z0-9][A-Z0-9_-]{0,127}$/u.test(code)
    ) &&
    new Set(item.failureCodes).size === item.failureCodes.length
  );
}

function hasUnknownFailureCode(item: { failureCodes: string[] }): boolean {
  return (
    !Array.isArray(item.failureCodes) ||
    item.failureCodes.some(
      (code) => getHardFailureDefinition(code) === undefined
    )
  );
}

function hasMissingHardFailureCode(item: {
  classification: ExternalValidityClassification;
  failureCodes: string[];
}): boolean {
  return (
    item.classification === "HARD_FAILURE" &&
    (!Array.isArray(item.failureCodes) ||
      !item.failureCodes.some(
        (code) => getHardFailureDefinition(code) !== undefined
      ))
  );
}

function hasInvalidP0GateSemantics(item: {
  classification: ExternalValidityClassification;
  gateDecision: ExternalValidityGateDecision;
  failureCodes: string[];
}): boolean {
  const hasP0 =
    Array.isArray(item.failureCodes) &&
    item.failureCodes.some(
      (code) => getHardFailureDefinition(code)?.severity === "P0"
    );
  return (
    hasP0 &&
    (item.classification !== "HARD_FAILURE" || item.gateDecision !== "BLOCK")
  );
}

function hasInvalidHardFailureSemantics(item: {
  classification: ExternalValidityClassification;
  gateDecision: ExternalValidityGateDecision;
  failureCodes: string[];
}): boolean {
  const hasRegisteredHardFailure =
    Array.isArray(item.failureCodes) &&
    item.failureCodes.some(
      (code) => getHardFailureDefinition(code) !== undefined
    );
  return (
    hasRegisteredHardFailure &&
    (item.classification !== "HARD_FAILURE" || item.gateDecision !== "BLOCK")
  );
}

function assertExternalValidityStudy(study: ExternalValidityStudy): void {
  if (
    study.schemaVersion !== "0.1.0" ||
    study.resultType !== "external_validity_study" ||
    study.protocolVersion !== "criterion-validity-v1" ||
    study.blinding.mode !== "double_blind" ||
    !isSha256(study.blinding.assignmentHash) ||
    study.targets.length === 0 ||
    study.items.length === 0
  ) {
    throw new Error("External validity study is missing required protocol fields.");
  }
  if (
    !allUnique(study.targets.map((target) => target.targetId)) ||
    !allUnique(study.targets.map((target) => target.blindedTargetId)) ||
    !allUnique(study.items.map((item) => item.itemId)) ||
    !allUnique(study.items.map((item) => item.blindedChangeId)) ||
    !allUnique(
      study.items.flatMap((item) => [item.itemId, item.blindedChangeId])
    )
  ) {
    throw new Error("External validity study contains duplicate semantic identities.");
  }
  const targetsById = new Map(
    study.targets.map((target) => [target.targetId, target])
  );
  if (
    study.targets.some(
      (target) =>
        !isSemanticId(target.targetId) ||
        !isSemanticId(target.blindedTargetId) ||
        !TARGET_CLASSES.includes(target.targetClass) ||
        !isSha256(target.targetRefHash) ||
        !isSha256(target.contractHash) ||
        !["reviewed", "pending_human_input"].includes(
          target.contractReview.status
        ) ||
        (target.contractReview.status === "reviewed" &&
          !isSha256(target.contractReview.artifactHash))
    ) ||
    study.items.some(
      (item) =>
        !isSemanticId(item.itemId) ||
        !isSemanticId(item.blindedChangeId) ||
        !targetsById.has(item.targetId) ||
        !RUNNERS.includes(item.runner) ||
        !DESIGN_STRATA.includes(item.designStratum) ||
        item.runnerBlindId === item.runner ||
        !isSemanticId(item.runnerBlindId) ||
        !isSha256(item.baseline.contentHash) ||
        !isSha256(item.candidate.contentHash)
    )
  ) {
    throw new Error("External validity study contains invalid public metadata.");
  }
  const refs = study.items.flatMap((item) => [item.baseline.ref, item.candidate.ref]);
  if (!refs.every(isPublicSafeRef)) {
    throw new Error(
      "External validity labeling requires public-safe external artifact references."
    );
  }
}

function hasIndependentRaters(
  labels: ExternalValidityHumanLabels,
  minimum: number
): boolean {
  const ids = labels.raters.map((rater) => rater.raterId);
  const roles = new Set(labels.raters.map((rater) => rater.role));
  return (
    labels.raters.length === minimum &&
    new Set(ids).size === minimum &&
    ids.every(isSemanticId) &&
    roles.has("workflow_owner") &&
    roles.has("independent_reviewer") &&
    labels.labels.every((label) => ids.includes(label.raterId)) &&
    labels.adjudications.every(
      (item) =>
        isSemanticId(item.adjudicatorId) &&
        !ids.includes(item.adjudicatorId)
    )
  );
}

function containsDuplicateEvidence(
  items: VerifiedExternalValidityObservation[]
): boolean {
  const comparisonHashes = items.map(
    (item) => item.evidence.comparisonHash
  );
  const attemptFingerprints = items.map(
    (item) => item.evidence.attemptFingerprint
  );
  return (
    new Set(comparisonHashes).size !== comparisonHashes.length ||
    new Set(attemptFingerprints).size !== attemptFingerprints.length
  );
}

function containsDuplicateObservationManifests(
  items: ExternalValidityObservationSet["items"]
): boolean {
  const comparisonHashes = items.map(
    (item) => item.evidence.comparisonHash
  );
  const comparisonRefs = items.map((item) => item.evidence.comparisonRef);
  return (
    new Set(comparisonHashes).size !== comparisonHashes.length ||
    new Set(comparisonRefs).size !== comparisonRefs.length
  );
}

function hasP0ReferenceLabel(
  labelsByItem: Map<string, ExternalValidityHumanLabels["labels"]>,
  adjudicationsByItem: Map<
    string,
    ExternalValidityHumanLabels["adjudications"][number]
  >
): boolean {
  for (const [itemId, labels] of labelsByItem) {
    const resolved = resolveHumanLabel(
      labels,
      adjudicationsByItem.get(itemId)
    );
    if (resolved && isP0HardFailure(resolved)) {
      return true;
    }
  }
  return false;
}

function isPublicSafeRef(ref: string): boolean {
  return (
    /^(?:external|https|ipfs):\/\//u.test(ref) &&
    !/(?:\/Users\/|\/home\/|\/private\/|@|private-target|company-domain)/iu.test(ref)
  );
}

function publicArtifactRef(artifact: ExternalValidityArtifactRef): ExternalValidityArtifactRef {
  return {
    ref: `external://artifact/${artifact.contentHash.replace("sha256:", "")}`,
    contentHash: artifact.contentHash
  };
}

function isSha256(value: string | undefined): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isSemanticId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function allUnique(values: string[]): boolean {
  return new Set(values).size === values.length;
}
