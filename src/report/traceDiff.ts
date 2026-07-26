import { PRODUCT_NAME } from "../core/product.js";
import type { RunEvent } from "../core/types.js";
import { getHardFailureDefinition } from "../evaluation/evaluationContract.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type TraceDiffMode = "baseline_candidate" | "baseline_mutant_restore";
export type TraceDeltaKind =
  | "added"
  | "removed"
  | "changed"
  | "unchanged"
  | "mutant_added"
  | "mutant_removed"
  | "mutant_changed"
  | "mutant_unchanged"
  | "restore_added"
  | "restore_removed"
  | "restore_changed"
  | "restore_unchanged";

export interface TraceInput {
  ref: string;
  traceHash: string;
  cases: Array<{
    caseId: string;
    templateId?: string;
    events: RunEvent[];
  }>;
}

export interface BuildTraceDiffInput {
  mode: TraceDiffMode;
  targetId: string;
  suite: string;
  comparability: {
    status: "COMPARABLE" | "INCOMPARABLE";
    reasons: string[];
  };
  evidenceLevel?: "verified_live" | "diagnostic_simulated";
  verification?: TraceDiffVerification;
  baseline: TraceInput;
  candidate?: TraceInput;
  mutant?: TraceInput;
  restore?: TraceInput;
  maxCases?: number;
  maxEventsPerCase?: number;
  maxTotalEvents?: number;
  maxPayloadBytes?: number;
}

export interface TraceDiff {
  schemaVersion: "0.1.0";
  artifactType: "trace_diff";
  product: typeof PRODUCT_NAME;
  targetId: string;
  suite: string;
  mode: TraceDiffMode;
  evidenceLevel: "verified_live" | "diagnostic_simulated";
  comparability: {
    status: "COMPARABLE" | "INCOMPARABLE";
    reasons: string[];
  };
  verification: TraceDiffVerification;
  sources: {
    baseline: TraceSourceRef;
    candidate?: TraceSourceRef;
    mutant?: TraceSourceRef;
    restore?: TraceSourceRef;
  };
  baselineTraceHash: string;
  candidateTraceHash?: string;
  mutantTraceHash?: string;
  restoreTraceHash?: string;
  restoreStatus?: "RESTORED" | "REGRESSED";
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  caseDiffs: TraceCaseDiff[];
  processDefects?: TraceProcessDefects;
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
    sourceTraceHashes: string[];
  };
}

interface TraceProcessDefects {
  summary: {
    added: number;
    removed: number;
    changed: number;
    p0: number;
    p1: number;
  };
  defects: TraceProcessDefect[];
}

export interface TraceProcessDefect {
  caseId: string;
  templateId?: string;
  code: string;
  direction: "added" | "removed" | "changed";
  severity: "P0" | "P1";
  definition: string;
  why: string;
  evidenceRefs: string[];
  baselineEventRef?: string;
  candidateEventRef?: string;
  mutantEventRef?: string;
  restoreEventRef?: string;
}

export interface TraceCaseDiff {
  caseId: string;
  templateId?: string;
  eventDeltas: TraceEventDelta[];
}

export interface TraceEventDelta {
  kind: TraceDeltaKind;
  type: RunEvent["type"];
  baselineRef?: string;
  candidateRef?: string;
  mutantRef?: string;
  restoreRef?: string;
  baselineTimestamp?: string;
  candidateTimestamp?: string;
  mutantTimestamp?: string;
  restoreTimestamp?: string;
  baselinePosition?: number;
  candidatePosition?: number;
  mutantPosition?: number;
  restorePosition?: number;
  baselinePayloadHash?: string;
  candidatePayloadHash?: string;
  mutantPayloadHash?: string;
  restorePayloadHash?: string;
  provenance: {
    baselineActorHash?: string;
    candidateActorHash?: string;
    mutantActorHash?: string;
    restoreActorHash?: string;
  };
}

export interface TraceDiffVerification {
  status: "QUALIFIED_SIGNED_TRACES" | "DIAGNOSTIC_UNVERIFIED";
  sourceTraceHashes: string[];
  observerKeyFingerprints: string[];
  qualificationArtifacts: Array<{
    ref: string;
    sha256: string;
  }>;
}

export interface TraceSourceRef {
  ref: string;
  traceHash: string;
}

const DEFAULT_MAX_CASES = 5_000;
const DEFAULT_MAX_EVENTS_PER_CASE = 10_000;
const DEFAULT_MAX_TOTAL_EVENTS = 50_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

type LabeledTrace = { label: "baseline" | "candidate" | "mutant" | "restore"; trace: TraceInput };
type IndexedEvent = {
  key: string;
  type: RunEvent["type"];
  event: RunEvent;
  position: number;
  ref: string;
  payloadHash: string;
  timestamp: string;
};

export function buildTraceDiff(input: BuildTraceDiffInput): TraceDiff {
  if (!input.targetId.trim() || !input.suite.trim()) {
    throw new Error("trace diff targetId and suite are required");
  }
  if (
    input.comparability.status === "INCOMPARABLE" &&
    input.comparability.reasons.length === 0
  ) {
    throw new Error("INCOMPARABLE trace diff requires at least one reason.");
  }
  if (
    input.comparability.status === "COMPARABLE" &&
    input.comparability.reasons.length > 0
  ) {
    throw new Error("COMPARABLE trace diff cannot include mismatch reasons.");
  }
  if (
    input.comparability.reasons.some((reason) => !reason.trim()) ||
    new Set(input.comparability.reasons).size !==
      input.comparability.reasons.length
  ) {
    throw new Error(
      "Trace diff comparability reasons must be unique non-empty values."
    );
  }
  const options = {
    maxCases: input.maxCases ?? DEFAULT_MAX_CASES,
    maxEventsPerCase: input.maxEventsPerCase ?? DEFAULT_MAX_EVENTS_PER_CASE,
    maxTotalEvents: input.maxTotalEvents ?? DEFAULT_MAX_TOTAL_EVENTS,
    maxPayloadBytes: input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  };
  if (input.mode === "baseline_candidate" && !input.candidate) {
    throw new Error("trace diff mode baseline_candidate requires candidate trace");
  }
  if (input.mode === "baseline_mutant_restore" && (!input.mutant || !input.restore)) {
    throw new Error("trace diff mode baseline_mutant_restore requires mutant and restore traces");
  }
  validateTrace({ label: "baseline", trace: input.baseline }, options);
  if (input.candidate) {
    validateTrace({ label: "candidate", trace: input.candidate }, options);
  }
  if (input.mutant) {
    validateTrace({ label: "mutant", trace: input.mutant }, options);
  }
  if (input.restore) {
    validateTrace({ label: "restore", trace: input.restore }, options);
  }
  assertDistinctTraceInputs(input);
  const selectedTraceHashes = inputTraceHashes(input);
  const requestedEvidenceLevel =
    input.comparability.status === "COMPARABLE"
      ? input.evidenceLevel ?? "diagnostic_simulated"
      : "diagnostic_simulated";
  const verification = normalizeVerification(
    requestedEvidenceLevel,
    selectedTraceHashes,
    input.verification
  );

  if (input.mode === "baseline_candidate") {
    const { caseDiffs, processDefects } = diffTwoTraces(
      input.baseline,
      input.candidate!,
      "candidate"
    );
    return withIntegrity({
      schemaVersion: "0.1.0",
      artifactType: "trace_diff",
      product: PRODUCT_NAME,
      targetId: input.targetId,
      suite: input.suite,
      mode: input.mode,
      evidenceLevel: requestedEvidenceLevel,
      comparability: input.comparability,
      verification,
      sources: {
        baseline: sourceRef(input.baseline),
        candidate: sourceRef(input.candidate!)
      },
      baselineTraceHash: input.baseline.traceHash,
      candidateTraceHash: input.candidate!.traceHash,
      ...(processDefects ? { processDefects } : {}),
      summary: summarize(caseDiffs),
      caseDiffs
    });
  }

  const mutantResult = diffTwoTraces(input.baseline, input.mutant!, "mutant");
  const restoreResult = diffTwoTraces(input.baseline, input.restore!, "restore");
  const mutantDiffs = mutantResult.caseDiffs;
  const restoreDiffs = restoreResult.caseDiffs;
  const caseDiffs = mergeCaseDiffs(mutantDiffs, restoreDiffs);
  const restoreSummary = summarize(restoreDiffs);
  return withIntegrity({
    schemaVersion: "0.1.0",
    artifactType: "trace_diff",
    product: PRODUCT_NAME,
    targetId: input.targetId,
    suite: input.suite,
    mode: input.mode,
    evidenceLevel: requestedEvidenceLevel,
    comparability: input.comparability,
    verification,
    sources: {
      baseline: sourceRef(input.baseline),
      mutant: sourceRef(input.mutant!),
      restore: sourceRef(input.restore!)
    },
    baselineTraceHash: input.baseline.traceHash,
    mutantTraceHash: input.mutant!.traceHash,
    restoreTraceHash: input.restore!.traceHash,
    ...(mutantResult.processDefects || restoreResult.processDefects
      ? {
          processDefects: mergeProcessDefects(
            mutantResult.processDefects,
            restoreResult.processDefects
          )
        }
      : {}),
    restoreStatus:
      restoreSummary.added === 0 && restoreSummary.removed === 0 && restoreSummary.changed === 0
        ? "RESTORED"
        : "REGRESSED",
    summary: summarize(caseDiffs),
    caseDiffs
  });
}

export function assertTraceDiffIntegrity(report: TraceDiff): void {
  const { integrity, ...content } = report;
  const sourceTraceHashes = traceHashes(content);
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content)) ||
    stableJson([...integrity.sourceTraceHashes].sort()) !==
      stableJson([...sourceTraceHashes].sort())
  ) {
    throw new Error("Trace diff integrity verification failed.");
  }
  if (
    stableJson([...report.verification.sourceTraceHashes].sort()) !==
      stableJson([...sourceTraceHashes].sort()) ||
    report.sources.baseline.traceHash !== report.baselineTraceHash ||
    (report.sources.candidate?.traceHash ?? report.candidateTraceHash) !==
      report.candidateTraceHash ||
    (report.sources.mutant?.traceHash ?? report.mutantTraceHash) !==
      report.mutantTraceHash ||
    (report.sources.restore?.traceHash ?? report.restoreTraceHash) !==
      report.restoreTraceHash
  ) {
    throw new Error("Trace diff source trace hash verification failed.");
  }
}

interface TraceDiffResult {
  caseDiffs: TraceCaseDiff[];
  processDefects?: TraceProcessDefects;
}

function diffTwoTraces(
  baseline: TraceInput,
  other: TraceInput,
  otherLabel: "candidate" | "mutant" | "restore"
): TraceDiffResult {
  const baselineCases = new Map(baseline.cases.map((traceCase) => [traceCase.caseId, traceCase]));
  const otherCases = new Map(other.cases.map((traceCase) => [traceCase.caseId, traceCase]));
  let processDefects: TraceProcessDefects | undefined;
  const caseDiffs = [...new Set([...baselineCases.keys(), ...otherCases.keys()])]
    .sort()
    .map((caseId) => {
      const baselineCase = baselineCases.get(caseId);
      const otherCase = otherCases.get(caseId);
      const baselineEvents = indexEvents(baseline.ref, baselineCase?.events ?? []);
      const otherEvents = indexEvents(other.ref, otherCase?.events ?? []);
      const reorderedKeys = reorderedEventKeys(baselineEvents, otherEvents);
      const eventDeltas = [...new Set([...baselineEvents.keys(), ...otherEvents.keys()])]
        .sort(compareEventKeys)
        .map((key) => {
          const baselineEvent = baselineEvents.get(key);
          const otherEvent = otherEvents.get(key);
          const delta = eventDelta(
            baselineEvent,
            otherEvent,
            otherLabel,
            reorderedKeys.has(key)
          );
          if (delta.type === "hard_failure" && !delta.kind.endsWith("unchanged")) {
            for (const change of hardFailureChanges(
              baselineEvent,
              otherEvent
            )) {
              const definition = getHardFailureDefinition(change.code);
              const baseDefect: TraceProcessDefect = {
                caseId,
                templateId:
                  baselineCase?.templateId ?? otherCase?.templateId,
                code: change.code,
                direction: change.direction,
                severity: (definition?.severity ??
                  "P1") as TraceProcessDefect["severity"],
                definition: definition
                  ? `${definition.code}:${definition.severity}:${definition.dimension}`
                  : "contract:unknown",
                why:
                  definition?.why ?? "Unknown hard-failure definition.",
                evidenceRefs: [
                  ...(baselineEvent ? [baselineEvent.ref] : []),
                  ...(otherEvent ? [otherEvent.ref] : [])
                ],
                ...(change.baselineEventRef
                  ? { baselineEventRef: change.baselineEventRef }
                  : {})
              };
              if (otherLabel === "candidate") {
                processDefects = addProcessDefect(processDefects, {
                  ...baseDefect,
                  ...(change.otherEventRef
                    ? { candidateEventRef: change.otherEventRef }
                    : {})
                });
              } else if (otherLabel === "mutant") {
                processDefects = addProcessDefect(processDefects, {
                  ...baseDefect,
                  ...(change.otherEventRef
                    ? { mutantEventRef: change.otherEventRef }
                    : {})
                });
              } else {
                processDefects = addProcessDefect(processDefects, {
                  ...baseDefect,
                  ...(change.otherEventRef
                    ? { restoreEventRef: change.otherEventRef }
                    : {})
                });
              }
            }
          }
          return delta;
        });
      return {
        caseId,
        templateId: baselineCase?.templateId ?? otherCase?.templateId,
        eventDeltas
      };
    });
  return { caseDiffs, processDefects };
}

function hardFailureChanges(
  baselineEvent: IndexedEvent | undefined,
  otherEvent: IndexedEvent | undefined
): Array<{
  code: string;
  direction: TraceProcessDefect["direction"];
  baselineEventRef?: string;
  otherEventRef?: string;
}> {
  const baselineCode = readHardFailureCode(baselineEvent);
  const otherCode = readHardFailureCode(otherEvent);
  if (baselineCode && otherCode && baselineCode !== otherCode) {
    return [
      {
        code: baselineCode,
        direction: "removed",
        baselineEventRef: baselineEvent!.ref
      },
      {
        code: otherCode,
        direction: "added",
        otherEventRef: otherEvent!.ref
      }
    ];
  }
  if (baselineCode && otherCode) {
    return [
      {
        code: baselineCode,
        direction: "changed",
        baselineEventRef: baselineEvent!.ref,
        otherEventRef: otherEvent!.ref
      }
    ];
  }
  if (baselineCode) {
    return [
      {
        code: baselineCode,
        direction: "removed",
        baselineEventRef: baselineEvent!.ref
      }
    ];
  }
  if (otherCode) {
    return [
      {
        code: otherCode,
        direction: "added",
        otherEventRef: otherEvent!.ref
      }
    ];
  }
  return [];
}

function readHardFailureCode(event: IndexedEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }
  const maybeCode = event.event.payload.code;
  return typeof maybeCode === "string" && maybeCode.trim().length > 0 ? maybeCode : undefined;
}

function addProcessDefect(
  existing: TraceProcessDefects | undefined,
  defect: TraceProcessDefect
): TraceProcessDefects {
  const accumulator: TraceProcessDefects = existing
    ? {
        summary: { ...existing.summary },
        defects: [...existing.defects]
      }
    : {
        summary: { added: 0, removed: 0, changed: 0, p0: 0, p1: 0 },
        defects: []
      };
  const duplicate = accumulator.defects.some(
    (item) =>
      item.caseId === defect.caseId &&
      item.code === defect.code &&
      item.direction === defect.direction &&
      item.evidenceRefs.length === defect.evidenceRefs.length &&
      item.evidenceRefs.every((ref) => defect.evidenceRefs.includes(ref))
  );
  if (duplicate) {
    return accumulator;
  }
  accumulator.defects.push(defect);
  accumulator.summary[defect.direction] += 1;
  if (defect.severity === "P0") {
    accumulator.summary.p0 += 1;
  } else {
    accumulator.summary.p1 += 1;
  }
  return accumulator;
}

function mergeProcessDefects(
  left: TraceProcessDefects | undefined,
  right: TraceProcessDefects | undefined
): TraceProcessDefects | undefined {
  if (!left && !right) {
    return undefined;
  }
  const merged: TraceProcessDefects = {
    summary: { added: 0, removed: 0, changed: 0, p0: 0, p1: 0 },
    defects: []
  };
  for (const defect of [...(left?.defects ?? []), ...(right?.defects ?? [])]) {
    // no-op merge logic relies on addProcessDefect dedup contract.
    const next = addProcessDefect(merged, defect);
    merged.summary = next.summary;
    merged.defects = next.defects;
  }
  return merged;
}

function eventDelta(
  baseline: IndexedEvent | undefined,
  other: IndexedEvent | undefined,
  otherLabel: "candidate" | "mutant" | "restore",
  orderChanged: boolean
): TraceEventDelta {
  if (!baseline && !other) {
    throw new Error("trace diff internal error: event pair is empty");
  }
  const baseKind = !baseline
    ? "added"
    : !other
      ? "removed"
      : !orderChanged &&
          baseline.payloadHash === other.payloadHash &&
          baseline.event.actor === other.event.actor
        ? "unchanged"
        : "changed";
  const kind = otherLabel === "candidate" ? baseKind : `${otherLabel}_${baseKind}` as TraceDeltaKind;
  return {
    kind,
    type: (baseline ?? other)!.type,
    ...(baseline
      ? {
          baselineRef: baseline.ref,
          baselinePosition: baseline.position,
          baselineTimestamp: baseline.timestamp,
          baselinePayloadHash: baseline.payloadHash
        }
      : {}),
    ...(other
      ? {
          [`${otherLabel}Ref`]: other.ref,
          [`${otherLabel}Position`]: other.position,
          [`${otherLabel}Timestamp`]: other.timestamp,
          [`${otherLabel}PayloadHash`]: other.payloadHash
        }
      : {}),
    provenance: {
      ...(baseline
        ? { baselineActorHash: sha256Text(baseline.event.actor) }
        : {}),
      ...(other
        ? { [`${otherLabel}ActorHash`]: sha256Text(other.event.actor) }
        : {})
    }
  } as TraceEventDelta;
}

function indexEvents(traceRef: string, events: RunEvent[]): Map<string, IndexedEvent> {
  const counts = new Map<string, number>();
  const indexed = new Map<string, IndexedEvent>();
  for (const [position, event] of events.entries()) {
    const count = (counts.get(event.type) ?? 0) + 1;
    counts.set(event.type, count);
    const key = `${count.toString().padStart(8, "0")}:${event.type}`;
    indexed.set(key, {
      key,
      type: event.type,
      event,
      position,
      ref: `${traceRef}#event=${event.eventId}`,
      payloadHash: sha256Text(stableJson(event.payload)),
      timestamp: event.timestamp
    });
  }
  return indexed;
}

function reorderedEventKeys(
  baselineEvents: Map<string, IndexedEvent>,
  otherEvents: Map<string, IndexedEvent>
): Set<string> {
  const baselineCommon = [...baselineEvents.keys()].filter((key) =>
    otherEvents.has(key)
  );
  const otherCommonPositions = new Map(
    [...otherEvents.keys()]
      .filter((key) => baselineEvents.has(key))
      .map((key, index) => [key, index])
  );
  return new Set(
    baselineCommon.filter(
      (key, index) => otherCommonPositions.get(key) !== index
    )
  );
}

function mergeCaseDiffs(left: TraceCaseDiff[], right: TraceCaseDiff[]): TraceCaseDiff[] {
  const byCase = new Map<string, TraceCaseDiff>();
  for (const item of [...left, ...right]) {
    const existing = byCase.get(item.caseId);
    if (!existing) {
      byCase.set(item.caseId, { ...item, eventDeltas: [...item.eventDeltas] });
    } else {
      existing.eventDeltas.push(...item.eventDeltas);
    }
  }
  return [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function summarize(caseDiffs: TraceCaseDiff[]): TraceDiff["summary"] {
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const delta of caseDiffs.flatMap((item) => item.eventDeltas)) {
    if (delta.kind.endsWith("unchanged")) {
      summary.unchanged += 1;
    } else if (delta.kind.endsWith("added")) {
      summary.added += 1;
    } else if (delta.kind.endsWith("removed")) {
      summary.removed += 1;
    } else if (delta.kind.endsWith("changed")) {
      summary.changed += 1;
    }
  }
  return summary;
}

function validateTrace(
  input: LabeledTrace,
  bounds: {
    maxCases: number;
    maxEventsPerCase: number;
    maxTotalEvents: number;
    maxPayloadBytes: number;
  }
): void {
  if (!isPortableRef(input.trace.ref)) {
    throw new Error(`trace diff ${input.label} has non-portable ref: ${input.trace.ref}`);
  }
  if (!isHashShape(input.trace.traceHash)) {
    throw new Error(`trace diff ${input.label} has invalid traceHash shape`);
  }
  if (input.trace.cases.length > bounds.maxCases) {
    throw new Error(
      `trace diff ${input.label} exceeds maxCases: ${input.trace.cases.length} > ${bounds.maxCases}`
    );
  }
  let totalEvents = 0;
  const caseIds = new Set<string>();
  for (const traceCase of input.trace.cases) {
    if (caseIds.has(traceCase.caseId)) {
      throw new Error(`trace diff ${input.label} has duplicate caseId: ${traceCase.caseId}`);
    }
    caseIds.add(traceCase.caseId);
    if (traceCase.events.length > bounds.maxEventsPerCase) {
      throw new Error(
        `trace diff ${input.label}/${traceCase.caseId} exceeds maxEventsPerCase: ${traceCase.events.length} > ${bounds.maxEventsPerCase}`
      );
    }
    totalEvents += traceCase.events.length;
    if (totalEvents > bounds.maxTotalEvents) {
      throw new Error(
        `trace diff ${input.label} exceeds maxTotalEvents: ${totalEvents} > ${bounds.maxTotalEvents}`
      );
    }
    const eventIds = new Set<string>();
    for (const event of traceCase.events) {
      const eventTime = Date.parse(event.timestamp);
      if (!Number.isFinite(eventTime)) {
        throw new Error(
          `trace diff ${input.label}/${traceCase.caseId}/${event.eventId} has invalid event timestamp`
        );
      }
      if (
        redactSensitiveText(event.eventId) !== event.eventId ||
        !isPortableRef(`${input.trace.ref}#event=${event.eventId}`)
      ) {
        throw new Error(
          `trace diff ${input.label}/${traceCase.caseId} has a non-portable eventId`
        );
      }
      if (eventIds.has(event.eventId)) {
        throw new Error(
          `trace diff ${input.label}/${traceCase.caseId} has duplicate eventId: ${event.eventId}`
        );
      }
      eventIds.add(event.eventId);
      const payloadBytes = Buffer.byteLength(stableJson(event.payload), "utf8");
      if (payloadBytes > bounds.maxPayloadBytes) {
        throw new Error(
          `trace diff ${input.label}/${traceCase.caseId}/${event.eventId} exceeds maxPayloadBytes: ${payloadBytes} > ${bounds.maxPayloadBytes}`
        );
      }
    }
  }
}

function sourceRef(trace: TraceInput): TraceSourceRef {
  return {
    ref: trace.ref,
    traceHash: trace.traceHash
  };
}

function withIntegrity(
  content: Omit<TraceDiff, "integrity">
): TraceDiff {
  return {
    ...content,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(content)),
      sourceTraceHashes: traceHashes(content)
    }
  };
}

function isPortableRef(ref: string): boolean {
  return (
    ref.length <= 512 &&
    /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/#:=+-]*$/u.test(ref) &&
    !ref.includes("..")
  );
}

function isHashShape(hash: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(hash);
}

function traceHashes(content: Omit<TraceDiff, "integrity">): string[] {
  return [
    content.baselineTraceHash,
    content.candidateTraceHash,
    content.mutantTraceHash,
    content.restoreTraceHash
  ].filter((value): value is string => value !== undefined);
}

function inputTraceHashes(input: BuildTraceDiffInput): string[] {
  return [
    input.baseline.traceHash,
    input.candidate?.traceHash,
    input.mutant?.traceHash,
    input.restore?.traceHash
  ].filter((value): value is string => value !== undefined);
}

function normalizeVerification(
  evidenceLevel: TraceDiff["evidenceLevel"],
  sourceTraceHashes: string[],
  verification: TraceDiffVerification | undefined
): TraceDiffVerification {
  if (evidenceLevel !== "verified_live") {
    return verification ?? {
      status: "DIAGNOSTIC_UNVERIFIED",
      sourceTraceHashes,
      observerKeyFingerprints: [],
      qualificationArtifacts: []
    };
  }
  if (
    verification?.status !== "QUALIFIED_SIGNED_TRACES" ||
    stableJson([...verification.sourceTraceHashes].sort()) !==
      stableJson([...sourceTraceHashes].sort()) ||
    verification.observerKeyFingerprints.length === 0 ||
    verification.qualificationArtifacts.length === 0 ||
    verification.observerKeyFingerprints.some(
      (fingerprint) => !isHashShape(fingerprint)
    ) ||
    verification.qualificationArtifacts.some(
      (artifact) =>
        !isPortableRef(artifact.ref) || !isHashShape(artifact.sha256)
    )
  ) {
    throw new Error(
      "verified_live trace diffs require source-matched Observer qualification bindings."
    );
  }
  return verification;
}

function assertDistinctTraceInputs(input: BuildTraceDiffInput): void {
  const traces = [
    input.baseline,
    input.candidate,
    input.mutant,
    input.restore
  ].filter((trace): trace is TraceInput => trace !== undefined);
  if (new Set(traces.map((trace) => trace.ref)).size !== traces.length) {
    throw new Error("trace diff source refs must be unique");
  }
  if (
    new Set(traces.map((trace) => trace.traceHash)).size !== traces.length
  ) {
    throw new Error("trace diff source hashes must be unique");
  }
}

function compareEventKeys(left: string, right: string): number {
  const [leftIndex, leftType] = left.split(":");
  const [rightIndex, rightType] = right.split(":");
  const indexDelta = Number(leftIndex) - Number(rightIndex);
  return indexDelta === 0 ? leftType.localeCompare(rightType) : indexDelta;
}
