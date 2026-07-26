import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
import {
  assertTraceDiffIntegrity,
  type TraceDiff,
  type TraceEventDelta,
  type TraceProcessDefect
} from "./traceDiff.js";

export type TrajectoryReviewStatus = "DIAGNOSTIC_ONLY";
export type TrajectoryReviewGateAuthority = "NONE";
export type DefectClass =
  | "route_integrity"
  | "join_integrity"
  | "artifact_integrity"
  | "side_effect_safety"
  | "state_integrity"
  | "terminal_integrity"
  | "process_failure";

export interface JudgeTrajectoryFindings {
  model: string;
  promptHash: string;
  rubricHash: string;
  calibrationSetIdentity: string;
  findings: JudgeTrajectoryFinding[];
}

export interface JudgeTrajectoryFinding {
  findingId: string;
  defectClass: DefectClass;
  severity: "info" | "low" | "medium" | "high" | "critical";
  verdict: "defect" | "not_a_defect" | "uncertain";
  evidenceRefs: string[];
  rationale: string;
}

export interface HumanTrajectoryLabels {
  blinded: true;
  raters: Array<{
    raterId: string;
    expertise: string;
  }>;
  labels: Array<{
    raterId: string;
    findingId: string;
    defectClass: DefectClass;
    isDefect: boolean;
    evidenceRefs?: string[];
  }>;
}

export interface BuildTrajectoryReviewInput {
  traceDiff: TraceDiff;
  traceDiffRef: string;
  traceDiffHash: string;
  judgeFindings?: JudgeTrajectoryFindings;
  humanLabels?: HumanTrajectoryLabels;
}

export interface TrajectoryFinding {
  findingId: string;
  caseId: string;
  templateId?: string;
  lane: "candidate" | "baseline" | "mutant" | "restore";
  defectClass: DefectClass;
  failureCode: string;
  severity: "P0" | "P1";
  direction: "added" | "removed" | "changed";
  onset: {
    step: number;
    ref: string;
  };
  propagationRefs: string[];
  detection: {
    step: number;
    ref: string;
    latencySteps: number;
  };
  recovery: {
    attempts: number;
    outcome: "not_attempted" | "restored" | "failed" | "not_applicable";
    recoveryRef?: string;
    recoveryStep?: number;
    recoveryLatencyMs?: number;
  };
  finalOutcome: "regressed" | "restored" | "improved" | "unchanged";
}

export interface TrajectoryReviewReport {
  schemaVersion: "0.1.0";
  artifactType: "trajectory_review";
  product: typeof PRODUCT_NAME;
  status: TrajectoryReviewStatus;
  gateAuthority: TrajectoryReviewGateAuthority;
  reasonCodes: ["DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY"];
  source: {
    ref: string;
    sha256: string;
    traceDiffContentHash: string;
    mode: TraceDiff["mode"];
    sourceTraceHashes: string[];
  };
  taxonomy: {
    name: "awb_process_defect_taxonomy";
    version: "0.1.0";
    classes: DefectClass[];
  };
  summary: {
    deterministicFindings: number;
    judgeFindings: number;
    validatedClasses: number;
  };
  deterministicFindings: TrajectoryFinding[];
  judgeFindings?: JudgeTrajectoryFindings;
  validation:
    | {
        status: "UNVALIDATED";
        reason: "Human trajectory labels were not supplied.";
        metricsByClass: [];
      }
    | {
        status: "VALIDATED_DIAGNOSTIC";
        raters: string[];
        interRaterAgreement: number;
        metricsByClass: Array<{
          defectClass: DefectClass;
          truePositive: number;
          falsePositive: number;
          falseNegative: number;
          precision: number;
          recall: number;
        }>;
        disagreements: Array<{
          findingId: string;
          defectClass: DefectClass;
          positiveLabels: number;
          negativeLabels: number;
          disposition: "NO_CONSENSUS";
        }>;
      };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

const TAXONOMY_CLASSES: DefectClass[] = [
  "route_integrity",
  "join_integrity",
  "artifact_integrity",
  "side_effect_safety",
  "state_integrity",
  "terminal_integrity",
  "process_failure"
];

export function buildTrajectoryReview(
  input: BuildTrajectoryReviewInput
): TrajectoryReviewReport {
  assertTraceDiffIntegrity(input.traceDiff);
  if (input.traceDiffHash !== sha256Text(stableJson(input.traceDiff))) {
    throw new Error("Trace diff source hash does not match content.");
  }
  const refs = traceDiffRefs(input.traceDiff);
  validateJudgeFindings(input.judgeFindings, refs);
  validateHumanLabels(input.humanLabels, input.judgeFindings, refs);
  const deterministicFindings = deterministicFindingsFromTraceDiff(
    input.traceDiff,
    refs
  );
  const validation = input.humanLabels
    ? validateJudgeAgainstHumanLabels(
        input.judgeFindings!,
        input.humanLabels
      )
    : ({
        status: "UNVALIDATED",
        reason: "Human trajectory labels were not supplied.",
        metricsByClass: []
      } satisfies TrajectoryReviewReport["validation"]);
  const reportWithoutIntegrity = {
    schemaVersion: "0.1.0" as const,
    artifactType: "trajectory_review" as const,
    product: PRODUCT_NAME as typeof PRODUCT_NAME,
    status: "DIAGNOSTIC_ONLY" as const,
    gateAuthority: "NONE" as const,
    reasonCodes: ["DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY"] as [
      "DIAGNOSTIC_ONLY_NO_GATE_AUTHORITY"
    ],
    source: {
      ref: input.traceDiffRef,
      sha256: input.traceDiffHash,
      traceDiffContentHash: input.traceDiff.integrity.contentHash,
      mode: input.traceDiff.mode,
      sourceTraceHashes: [...input.traceDiff.integrity.sourceTraceHashes].sort()
    },
    taxonomy: {
      name: "awb_process_defect_taxonomy" as const,
      version: "0.1.0" as const,
      classes: TAXONOMY_CLASSES
    },
    summary: {
      deterministicFindings: deterministicFindings.length,
      judgeFindings: input.judgeFindings?.findings.length ?? 0,
      validatedClasses: validation.metricsByClass.length
    },
    deterministicFindings,
    ...(input.judgeFindings
      ? { judgeFindings: normalizeJudgeFindings(input.judgeFindings) }
      : {}),
    validation
  };
  return {
    ...reportWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(reportWithoutIntegrity))
    }
  };
}

export function assertTrajectoryReviewIntegrity(
  report: TrajectoryReviewReport
): void {
  const { integrity, ...content } = report;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Trajectory review integrity verification failed.");
  }
}

export function renderTrajectoryReviewMarkdown(
  report: TrajectoryReviewReport
): string {
  const rows = report.deterministicFindings.map(
    (finding) =>
      `| ${finding.findingId} | ${finding.defectClass} | ${finding.failureCode} | ${finding.severity} | ${finding.direction} | ${finding.onset.ref} | ${finding.recovery.outcome} | ${finding.finalOutcome} | ${finding.recovery.recoveryRef ?? ""} | ${finding.recovery.recoveryStep ?? ""} | ${finding.recovery.recoveryLatencyMs ?? ""} |`
  );
  const metricRows = report.validation.metricsByClass.map(
    (metric) =>
      `| ${metric.defectClass} | ${metric.truePositive} | ${metric.falsePositive} | ${metric.falseNegative} | ${metric.precision} | ${metric.recall} |`
  );
  const disagreementRows =
    report.validation.status === "VALIDATED_DIAGNOSTIC"
      ? report.validation.disagreements.map(
          (entry) =>
            `| ${entry.findingId} | ${entry.defectClass} | ${entry.positiveLabels} | ${entry.negativeLabels} | ${entry.disposition} |`
        )
      : [];
  return [
    "# Trajectory Review",
    "",
    `Status: ${report.status}`,
    `Gate authority: ${report.gateAuthority}`,
    `Trace diff: ${report.source.ref}`,
    `Taxonomy: ${report.taxonomy.name}@${report.taxonomy.version}`,
    "",
    "## Deterministic Findings",
    "| id | class | failure | severity | direction | onset | recovery | outcome | recovery ref | recovery step | recovery latency ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length > 0
      ? rows
      : [
          "| none | none | none | none | none | none | none | none | none | none | none |"
        ]),
    "",
    "## Validation",
    `Status: ${report.validation.status}`,
    "metricsByClass" in report.validation && report.validation.metricsByClass.length > 0
      ? [
          "| class | TP | FP | FN | precision | recall |",
          "| --- | ---: | ---: | ---: | ---: | ---: |",
          ...metricRows
        ].join("\n")
      : "UNVALIDATED",
    "",
    "## Judge Findings",
    report.judgeFindings
      ? `Recorded: ${report.judgeFindings.findings.length}`
      : "None",
    "",
    "## Human-label Disagreements",
    "| finding | class | positive | negative | disposition |",
    "| --- | --- | ---: | ---: | --- |",
    ...(disagreementRows.length > 0
      ? disagreementRows
      : ["| none | none | 0 | 0 | none |"])
  ].join("\n");
}

function deterministicFindingsFromTraceDiff(
  traceDiff: TraceDiff,
  refs: Map<string, RefLocation>
): TrajectoryFinding[] {
  return (traceDiff.processDefects?.defects ?? []).map((defect) => {
    const detectionRef = preferredDefectRef(defect);
    const detection = refs.get(detectionRef);
    if (!detection || detection.type !== "hard_failure") {
      throw new Error("Trace diff process defect references an unknown event ref.");
    }
    const lane = detection.lane;
    const causalRefs = causalRefsForFinding(
      traceDiff,
      defect.caseId,
      lane,
      detection.position,
      refs
    );
    const onsetRef = causalRefs[0] ?? detectionRef;
    const onset = refs.get(onsetRef)!;
    const recovery = recoveryForDefect(traceDiff, defect, lane, refs);
    return {
      findingId: `det-${defect.caseId}-${defect.code}-${defect.direction}-${lane}`,
      caseId: defect.caseId,
      ...(defect.templateId ? { templateId: defect.templateId } : {}),
      lane,
      defectClass: defectClassForCode(defect.code),
      failureCode: defect.code,
      severity: defect.severity,
      direction: defect.direction,
      onset: {
        step: onset.position,
        ref: onsetRef
      },
      propagationRefs: causalRefs.slice(1),
      detection: {
        step: detection.position,
        ref: detectionRef,
        latencySteps: Math.max(0, detection.position - onset.position)
      },
      recovery,
      finalOutcome: finalOutcomeFor(defect, recovery)
    };
  }).sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function traceDiffRefs(traceDiff: TraceDiff): Map<string, RefLocation> {
  const refs = new Map<string, RefLocation>();
  for (const caseDiff of traceDiff.caseDiffs) {
    for (const delta of caseDiff.eventDeltas) {
      collectRef(refs, caseDiff.caseId, delta, "baseline");
      collectRef(refs, caseDiff.caseId, delta, "candidate");
      collectRef(refs, caseDiff.caseId, delta, "mutant");
      collectRef(refs, caseDiff.caseId, delta, "restore");
    }
  }
  return refs;
}

type RefLane = "baseline" | "candidate" | "mutant" | "restore";

interface RefLocation {
  caseId: string;
  type: TraceEventDelta["type"];
  lane: RefLane;
  position: number;
  timestampMs?: number;
}

function collectRef(
  refs: Map<string, RefLocation>,
  caseId: string,
  delta: TraceEventDelta,
  lane: RefLane
): void {
  const ref = delta[`${lane}Ref` as keyof TraceEventDelta];
  const position = delta[`${lane}Position` as keyof TraceEventDelta];
  const timestamp = delta[`${lane}Timestamp` as keyof TraceEventDelta];
  if (typeof ref === "string" && typeof position === "number") {
    refs.set(ref, {
      caseId,
      type: delta.type,
      lane,
      position,
      timestampMs:
        typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
          ? Date.parse(timestamp)
          : undefined
    });
  }
}

function validateJudgeFindings(
  judgeFindings: JudgeTrajectoryFindings | undefined,
  refs: Map<string, RefLocation>
): void {
  if (!judgeFindings) {
    return;
  }
  if (
    !judgeFindings.model.trim() ||
    !isHash(judgeFindings.promptHash) ||
    !isHash(judgeFindings.rubricHash) ||
    !judgeFindings.calibrationSetIdentity.trim()
  ) {
    throw new Error("Judge trajectory findings require model, prompt hash, rubric hash, and calibration identity.");
  }
  const findingIds = new Set<string>();
  for (const finding of judgeFindings.findings) {
    if (
      !finding.findingId.trim() ||
      findingIds.has(finding.findingId) ||
      !finding.rationale.trim() ||
      finding.evidenceRefs.length === 0 ||
      new Set(finding.evidenceRefs).size !== finding.evidenceRefs.length
    ) {
      throw new Error("Judge trajectory findings require at least one event ref.");
    }
    findingIds.add(finding.findingId);
    assertKnownRefs(finding.evidenceRefs, refs);
  }
}

function validateHumanLabels(
  labels: HumanTrajectoryLabels | undefined,
  judgeFindings: JudgeTrajectoryFindings | undefined,
  refs: Map<string, RefLocation>
): void {
  if (!labels) {
    return;
  }
  if (!judgeFindings) {
    throw new Error(
      "Human trajectory calibration labels require judge findings."
    );
  }
  if (labels.blinded !== true || labels.raters.length < 2) {
    throw new Error("Human trajectory labels require at least two blinded raters.");
  }
  const raterIds = new Set(labels.raters.map((rater) => rater.raterId));
  if (
    raterIds.size !== labels.raters.length ||
    labels.raters.some(
      (rater) => !rater.raterId.trim() || !rater.expertise.trim()
    )
  ) {
    throw new Error("Human trajectory labels require unique raters.");
  }
  const findingsById = new Map(
    judgeFindings.findings.map((finding) => [finding.findingId, finding])
  );
  const labelKeys = new Set<string>();
  for (const label of labels.labels) {
    if (!raterIds.has(label.raterId)) {
      throw new Error("Human trajectory label references an unknown rater.");
    }
    const finding = findingsById.get(label.findingId);
    if (!finding || finding.defectClass !== label.defectClass) {
      throw new Error(
        "Human trajectory label references an unknown or mismatched judge finding."
      );
    }
    const labelKey = `${label.raterId}\0${label.findingId}`;
    if (labelKeys.has(labelKey)) {
      throw new Error("Human trajectory labels contain a duplicate judgment.");
    }
    labelKeys.add(labelKey);
    assertKnownRefs(label.evidenceRefs ?? [], refs);
  }
  const expectedLabelCount = raterIds.size * findingsById.size;
  if (
    labelKeys.size !== expectedLabelCount ||
    [...raterIds].some((raterId) =>
      [...findingsById.keys()].some(
        (findingId) => !labelKeys.has(`${raterId}\0${findingId}`)
      )
    )
  ) {
    throw new Error(
      "Human trajectory calibration requires a complete blinded label matrix."
    );
  }
}

function assertKnownRefs(
  evidenceRefs: string[],
  refs: Map<string, RefLocation>
): void {
  for (const ref of evidenceRefs) {
    if (!refs.has(ref)) {
      throw new Error("Unknown trajectory event ref.");
    }
  }
}

function normalizeJudgeFindings(
  judgeFindings: JudgeTrajectoryFindings
): JudgeTrajectoryFindings {
  return {
    model: redactSensitiveText(judgeFindings.model),
    promptHash: judgeFindings.promptHash,
    rubricHash: judgeFindings.rubricHash,
    calibrationSetIdentity: redactSensitiveText(
      judgeFindings.calibrationSetIdentity
    ),
    findings: [...judgeFindings.findings]
      .map((finding) => ({
        ...finding,
        rationale: redactSensitiveText(finding.rationale)
      }))
      .sort((left, right) => left.findingId.localeCompare(right.findingId))
  };
}

function validateJudgeAgainstHumanLabels(
  judgeFindings: JudgeTrajectoryFindings,
  labels: HumanTrajectoryLabels
): TrajectoryReviewReport["validation"] {
  const consensus = consensusLabels(labels);
  const disagreements = disagreementRecords(judgeFindings, labels);
  const classes = [
    ...new Set(judgeFindings.findings.map((finding) => finding.defectClass))
  ].sort() as DefectClass[];
  const metricsByClass = classes.map((defectClass) => {
    const classFindings = judgeFindings.findings.filter(
      (finding) => finding.defectClass === defectClass
    );
    const truePositive = classFindings.filter(
      (finding) =>
        finding.verdict === "defect" &&
        consensus.get(finding.findingId) === true
    ).length;
    const falsePositive = classFindings.filter(
      (finding) =>
        finding.verdict === "defect" &&
        consensus.get(finding.findingId) === false
    ).length;
    const falseNegative = classFindings.filter(
      (finding) =>
        finding.verdict !== "defect" &&
        consensus.get(finding.findingId) === true
    ).length;
    return {
      defectClass,
      truePositive,
      falsePositive,
      falseNegative,
      precision: roundRate(
        truePositive + falsePositive === 0
          ? 0
          : truePositive / (truePositive + falsePositive)
      ),
      recall: roundRate(
        truePositive + falseNegative === 0
          ? 0
          : truePositive / (truePositive + falseNegative)
      )
    };
  });
  return {
    status: "VALIDATED_DIAGNOSTIC",
    raters: labels.raters.map((rater) => rater.raterId).sort(),
    interRaterAgreement: roundRate(interRaterAgreement(labels)),
    metricsByClass,
    disagreements
  };
}

function consensusLabels(
  labels: HumanTrajectoryLabels
): Map<string, boolean> {
  const byFinding = new Map<
    string,
    { positive: number; total: number }
  >();
  for (const label of labels.labels) {
    const item = byFinding.get(label.findingId) ?? {
      positive: 0,
      total: 0
    };
    item.total += 1;
    if (label.isDefect) {
      item.positive += 1;
    }
    byFinding.set(label.findingId, item);
  }
  return new Map(
    [...byFinding.entries()]
      .filter(([, item]) => item.positive * 2 !== item.total)
      .map(([findingId, item]) => [
        findingId,
        item.positive * 2 > item.total
      ])
  );
}

function disagreementRecords(
  judgeFindings: JudgeTrajectoryFindings,
  labels: HumanTrajectoryLabels
): Extract<
  TrajectoryReviewReport["validation"],
  { status: "VALIDATED_DIAGNOSTIC" }
>["disagreements"] {
  const findingById = new Map(
    judgeFindings.findings.map((finding) => [finding.findingId, finding])
  );
  const tallies = new Map<string, { positive: number; negative: number }>();
  for (const label of labels.labels) {
    const tally = tallies.get(label.findingId) ?? {
      positive: 0,
      negative: 0
    };
    if (label.isDefect) {
      tally.positive += 1;
    } else {
      tally.negative += 1;
    }
    tallies.set(label.findingId, tally);
  }
  return [...tallies.entries()]
    .filter(([, tally]) => tally.positive === tally.negative)
    .map(([findingId, tally]) => ({
      findingId,
      defectClass: findingById.get(findingId)!.defectClass,
      positiveLabels: tally.positive,
      negativeLabels: tally.negative,
      disposition: "NO_CONSENSUS" as const
    }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function interRaterAgreement(labels: HumanTrajectoryLabels): number {
  const byRater = new Map<string, Map<string, boolean>>();
  for (const label of labels.labels) {
    const raterLabels = byRater.get(label.raterId) ?? new Map<string, boolean>();
    raterLabels.set(label.findingId, label.isDefect);
    byRater.set(label.raterId, raterLabels);
  }
  let agreed = 0;
  let compared = 0;
  const raters = [...byRater.keys()].sort();
  for (let leftIndex = 0; leftIndex < raters.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < raters.length; rightIndex += 1) {
      const left = byRater.get(raters[leftIndex]!)!;
      const right = byRater.get(raters[rightIndex]!)!;
      for (const findingId of [...left.keys()].filter((id) => right.has(id))) {
        compared += 1;
        if (left.get(findingId) === right.get(findingId)) {
          agreed += 1;
        }
      }
    }
  }
  return compared === 0 ? 0 : agreed / compared;
}

function preferredDefectRef(defect: TraceProcessDefect): string {
  return (
    defect.candidateEventRef ??
    defect.mutantEventRef ??
    defect.restoreEventRef ??
    defect.baselineEventRef ??
    defect.evidenceRefs[0]!
  );
}

const CAUSAL_EVENT_TYPES = new Set<TraceEventDelta["type"]>([
  "handoff",
  "gate_decision",
  "artifact_write",
  "state_read",
  "side_effect_attempt",
  "runner_result",
  "runner_exit",
  "filesystem_access",
  "tool_call",
  "process_spawn",
  "network_access"
]);

function causalRefsForFinding(
  traceDiff: TraceDiff,
  caseId: string,
  lane: RefLane,
  detectionPosition: number,
  refs: Map<string, RefLocation>
): string[] {
  const caseDiff = traceDiff.caseDiffs.find((item) => item.caseId === caseId);
  if (!caseDiff) {
    return [];
  }
  return caseDiff.eventDeltas
    .filter(
      (delta) =>
        CAUSAL_EVENT_TYPES.has(delta.type) &&
        !delta.kind.endsWith("unchanged")
    )
    .flatMap((delta) => {
      const ref = delta[`${lane}Ref` as keyof TraceEventDelta];
      return typeof ref === "string" ? [ref] : [];
    })
    .filter((ref) => {
      const location = refs.get(ref);
      return (
        location?.caseId === caseId &&
        location.lane === lane &&
        location.position < detectionPosition
      );
    })
    .sort((left, right) => refs.get(left)!.position - refs.get(right)!.position);
}

function defectClassForCode(code: string): DefectClass {
  if (code.includes("ROUTE")) {
    return "route_integrity";
  }
  if (code.includes("JOIN")) {
    return "join_integrity";
  }
  if (code.includes("ARTIFACT")) {
    return "artifact_integrity";
  }
  if (code.includes("SIDE_EFFECT")) {
    return "side_effect_safety";
  }
  if (code.includes("STATE")) {
    return "state_integrity";
  }
  if (code.includes("TERMINAL") || code.includes("EXIT")) {
    return "terminal_integrity";
  }
  return "process_failure";
}

function recoveryForDefect(
  traceDiff: TraceDiff,
  defect: TraceProcessDefect,
  lane: TrajectoryFinding["lane"],
  refs: Map<string, RefLocation>
): TrajectoryFinding["recovery"] {
  if (traceDiff.mode !== "baseline_mutant_restore") {
    return { attempts: 0, outcome: "not_attempted" };
  }
  if (lane === "mutant") {
    const relatedRestoreDefects = (traceDiff.processDefects?.defects ?? []).filter(
      (item) => item.caseId === defect.caseId && item.code === defect.code
    );
    const matchedRestore =
      relatedRestoreDefects.find(
        (item) =>
          (defect.direction === "added" && item.direction === "removed") ||
          (defect.direction === "removed" && item.direction === "added") ||
          item.direction === "changed"
      ) ?? relatedRestoreDefects[0];
    const recoveryRef =
      matchedRestore?.restoreEventRef ??
      matchedRestore?.baselineEventRef ??
      matchedRestore?.candidateEventRef;
    const recoveryLocation = recoveryRef ? refs.get(recoveryRef) : undefined;
    const detectionRef =
      defect.mutantEventRef ?? defect.baselineEventRef ?? defect.candidateEventRef;
    const detectionLocation = detectionRef ? refs.get(detectionRef) : undefined;
    const recoveryLatencyMs =
      detectionLocation?.timestampMs !== undefined &&
      recoveryLocation?.timestampMs !== undefined
        ? Math.max(0, recoveryLocation.timestampMs - detectionLocation.timestampMs)
        : undefined;
    if (traceDiff.restoreStatus === "RESTORED") {
      return {
        attempts: Math.max(1, relatedRestoreDefects.length),
        outcome: "restored",
        ...(recoveryRef ? { recoveryRef } : {}),
        ...(recoveryLocation
          ? {
              recoveryStep: recoveryLocation.position
            }
          : {}),
        ...(recoveryLatencyMs !== undefined
          ? { recoveryLatencyMs }
          : {})
      };
    }
    const matched = matchedRestore !== undefined;
    return {
      attempts: 1,
      outcome: matched ? "restored" : "failed",
      ...(recoveryRef ? { recoveryRef } : {}),
      ...(recoveryLocation
        ? {
            recoveryStep: recoveryLocation.position
          }
        : {}),
      ...(recoveryLatencyMs !== undefined
        ? { recoveryLatencyMs }
        : {})
    };
  }
  if (lane === "restore") {
    return { attempts: 1, outcome: "failed" };
  }
  if (defect.restoreEventRef) {
    return { attempts: 1, outcome: "failed" };
  }
  return { attempts: 0, outcome: "not_applicable" };
}

function finalOutcomeFor(
  defect: TraceProcessDefect,
  recovery: TrajectoryFinding["recovery"]
): TrajectoryFinding["finalOutcome"] {
  if (recovery.outcome === "restored") {
    return "restored";
  }
  if (defect.direction === "removed") {
    return "improved";
  }
  if (defect.direction === "added" || defect.direction === "changed") {
    return "regressed";
  }
  return "unchanged";
}

function roundRate(value: number): number {
  return Number(value.toFixed(12));
}

function isHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}
