import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
const DEFAULT_MAX_CASES = 5_000;
const DEFAULT_MAX_EVENTS_PER_CASE = 10_000;
const DEFAULT_MAX_TOTAL_EVENTS = 50_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export function buildTraceDiff(input) {
    if (!input.targetId.trim() || !input.suite.trim()) {
        throw new Error("trace diff targetId and suite are required");
    }
    if (input.comparability.status === "INCOMPARABLE" &&
        input.comparability.reasons.length === 0) {
        throw new Error("INCOMPARABLE trace diff requires at least one reason.");
    }
    if (input.comparability.status === "COMPARABLE" &&
        input.comparability.reasons.length > 0) {
        throw new Error("COMPARABLE trace diff cannot include mismatch reasons.");
    }
    if (input.comparability.reasons.some((reason) => !reason.trim()) ||
        new Set(input.comparability.reasons).size !==
            input.comparability.reasons.length) {
        throw new Error("Trace diff comparability reasons must be unique non-empty values.");
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
    const requestedEvidenceLevel = input.comparability.status === "COMPARABLE"
        ? input.evidenceLevel ?? "diagnostic_simulated"
        : "diagnostic_simulated";
    const verification = normalizeVerification(requestedEvidenceLevel, selectedTraceHashes, input.verification);
    if (input.mode === "baseline_candidate") {
        const caseDiffs = diffTwoTraces(input.baseline, input.candidate, "candidate");
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
                candidate: sourceRef(input.candidate)
            },
            baselineTraceHash: input.baseline.traceHash,
            candidateTraceHash: input.candidate.traceHash,
            summary: summarize(caseDiffs),
            caseDiffs
        });
    }
    const mutantDiffs = diffTwoTraces(input.baseline, input.mutant, "mutant");
    const restoreDiffs = diffTwoTraces(input.baseline, input.restore, "restore");
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
            mutant: sourceRef(input.mutant),
            restore: sourceRef(input.restore)
        },
        baselineTraceHash: input.baseline.traceHash,
        mutantTraceHash: input.mutant.traceHash,
        restoreTraceHash: input.restore.traceHash,
        restoreStatus: restoreSummary.added === 0 && restoreSummary.removed === 0 && restoreSummary.changed === 0
            ? "RESTORED"
            : "REGRESSED",
        summary: summarize(caseDiffs),
        caseDiffs
    });
}
function diffTwoTraces(baseline, other, otherLabel) {
    const baselineCases = new Map(baseline.cases.map((traceCase) => [traceCase.caseId, traceCase]));
    const otherCases = new Map(other.cases.map((traceCase) => [traceCase.caseId, traceCase]));
    return [...new Set([...baselineCases.keys(), ...otherCases.keys()])].sort().map((caseId) => {
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
            return eventDelta(baselineEvent, otherEvent, otherLabel, reorderedKeys.has(key));
        });
        return {
            caseId,
            templateId: baselineCase?.templateId ?? otherCase?.templateId,
            eventDeltas
        };
    });
}
function eventDelta(baseline, other, otherLabel, orderChanged) {
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
    const kind = otherLabel === "candidate" ? baseKind : `${otherLabel}_${baseKind}`;
    return {
        kind,
        type: (baseline ?? other).type,
        ...(baseline
            ? {
                baselineRef: baseline.ref,
                baselinePosition: baseline.position,
                baselinePayloadHash: baseline.payloadHash
            }
            : {}),
        ...(other
            ? {
                [`${otherLabel}Ref`]: other.ref,
                [`${otherLabel}Position`]: other.position,
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
    };
}
function indexEvents(traceRef, events) {
    const counts = new Map();
    const indexed = new Map();
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
            payloadHash: sha256Text(stableJson(event.payload))
        });
    }
    return indexed;
}
function reorderedEventKeys(baselineEvents, otherEvents) {
    const baselineCommon = [...baselineEvents.keys()].filter((key) => otherEvents.has(key));
    const otherCommonPositions = new Map([...otherEvents.keys()]
        .filter((key) => baselineEvents.has(key))
        .map((key, index) => [key, index]));
    return new Set(baselineCommon.filter((key, index) => otherCommonPositions.get(key) !== index));
}
function mergeCaseDiffs(left, right) {
    const byCase = new Map();
    for (const item of [...left, ...right]) {
        const existing = byCase.get(item.caseId);
        if (!existing) {
            byCase.set(item.caseId, { ...item, eventDeltas: [...item.eventDeltas] });
        }
        else {
            existing.eventDeltas.push(...item.eventDeltas);
        }
    }
    return [...byCase.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}
function summarize(caseDiffs) {
    const summary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    for (const delta of caseDiffs.flatMap((item) => item.eventDeltas)) {
        if (delta.kind.endsWith("unchanged")) {
            summary.unchanged += 1;
        }
        else if (delta.kind.endsWith("added")) {
            summary.added += 1;
        }
        else if (delta.kind.endsWith("removed")) {
            summary.removed += 1;
        }
        else if (delta.kind.endsWith("changed")) {
            summary.changed += 1;
        }
    }
    return summary;
}
function validateTrace(input, bounds) {
    if (!isPortableRef(input.trace.ref)) {
        throw new Error(`trace diff ${input.label} has non-portable ref: ${input.trace.ref}`);
    }
    if (!isHashShape(input.trace.traceHash)) {
        throw new Error(`trace diff ${input.label} has invalid traceHash shape`);
    }
    if (input.trace.cases.length > bounds.maxCases) {
        throw new Error(`trace diff ${input.label} exceeds maxCases: ${input.trace.cases.length} > ${bounds.maxCases}`);
    }
    let totalEvents = 0;
    const caseIds = new Set();
    for (const traceCase of input.trace.cases) {
        if (caseIds.has(traceCase.caseId)) {
            throw new Error(`trace diff ${input.label} has duplicate caseId: ${traceCase.caseId}`);
        }
        caseIds.add(traceCase.caseId);
        if (traceCase.events.length > bounds.maxEventsPerCase) {
            throw new Error(`trace diff ${input.label}/${traceCase.caseId} exceeds maxEventsPerCase: ${traceCase.events.length} > ${bounds.maxEventsPerCase}`);
        }
        totalEvents += traceCase.events.length;
        if (totalEvents > bounds.maxTotalEvents) {
            throw new Error(`trace diff ${input.label} exceeds maxTotalEvents: ${totalEvents} > ${bounds.maxTotalEvents}`);
        }
        const eventIds = new Set();
        for (const event of traceCase.events) {
            if (redactSensitiveText(event.eventId) !== event.eventId ||
                !isPortableRef(`${input.trace.ref}#event=${event.eventId}`)) {
                throw new Error(`trace diff ${input.label}/${traceCase.caseId} has a non-portable eventId`);
            }
            if (eventIds.has(event.eventId)) {
                throw new Error(`trace diff ${input.label}/${traceCase.caseId} has duplicate eventId: ${event.eventId}`);
            }
            eventIds.add(event.eventId);
            const payloadBytes = Buffer.byteLength(stableJson(event.payload), "utf8");
            if (payloadBytes > bounds.maxPayloadBytes) {
                throw new Error(`trace diff ${input.label}/${traceCase.caseId}/${event.eventId} exceeds maxPayloadBytes: ${payloadBytes} > ${bounds.maxPayloadBytes}`);
            }
        }
    }
}
function sourceRef(trace) {
    return {
        ref: trace.ref,
        traceHash: trace.traceHash
    };
}
function withIntegrity(content) {
    return {
        ...content,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(content)),
            sourceTraceHashes: traceHashes(content)
        }
    };
}
function isPortableRef(ref) {
    return (ref.length <= 512 &&
        /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._/#:=+-]*$/u.test(ref) &&
        !ref.includes(".."));
}
function isHashShape(hash) {
    return /^sha256:[a-f0-9]{64}$/u.test(hash);
}
function traceHashes(content) {
    return [
        content.baselineTraceHash,
        content.candidateTraceHash,
        content.mutantTraceHash,
        content.restoreTraceHash
    ].filter((value) => value !== undefined);
}
function inputTraceHashes(input) {
    return [
        input.baseline.traceHash,
        input.candidate?.traceHash,
        input.mutant?.traceHash,
        input.restore?.traceHash
    ].filter((value) => value !== undefined);
}
function normalizeVerification(evidenceLevel, sourceTraceHashes, verification) {
    if (evidenceLevel !== "verified_live") {
        return verification ?? {
            status: "DIAGNOSTIC_UNVERIFIED",
            sourceTraceHashes,
            observerKeyFingerprints: [],
            qualificationArtifacts: []
        };
    }
    if (verification?.status !== "QUALIFIED_SIGNED_TRACES" ||
        stableJson([...verification.sourceTraceHashes].sort()) !==
            stableJson([...sourceTraceHashes].sort()) ||
        verification.observerKeyFingerprints.length === 0 ||
        verification.qualificationArtifacts.length === 0 ||
        verification.observerKeyFingerprints.some((fingerprint) => !isHashShape(fingerprint)) ||
        verification.qualificationArtifacts.some((artifact) => !isPortableRef(artifact.ref) || !isHashShape(artifact.sha256))) {
        throw new Error("verified_live trace diffs require source-matched Observer qualification bindings.");
    }
    return verification;
}
function assertDistinctTraceInputs(input) {
    const traces = [
        input.baseline,
        input.candidate,
        input.mutant,
        input.restore
    ].filter((trace) => trace !== undefined);
    if (new Set(traces.map((trace) => trace.ref)).size !== traces.length) {
        throw new Error("trace diff source refs must be unique");
    }
    if (new Set(traces.map((trace) => trace.traceHash)).size !== traces.length) {
        throw new Error("trace diff source hashes must be unique");
    }
}
function compareEventKeys(left, right) {
    const [leftIndex, leftType] = left.split(":");
    const [rightIndex, rightType] = right.split(":");
    const indexDelta = Number(leftIndex) - Number(rightIndex);
    return indexDelta === 0 ? leftType.localeCompare(rightType) : indexDelta;
}
