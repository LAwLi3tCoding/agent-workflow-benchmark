import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
export function importOtlpDiagnosticTrace(input) {
    assertPortableSourceRef(input.sourceRef);
    const sourceHash = sha256Text(stableJson(input.otlp));
    const resourceSpans = readArray(input.otlp, "resourceSpans");
    const events = [];
    let scopeSpanCount = 0;
    let spanCount = 0;
    let unknownSpans = 0;
    let redactedValues = 0;
    const warningCodes = new Set();
    for (const [resourceIndex, resourceSpan] of resourceSpans.entries()) {
        const scopeSpans = readArray(resourceSpan, "scopeSpans");
        scopeSpanCount += scopeSpans.length;
        for (const [scopeIndex, scopeSpan] of scopeSpans.entries()) {
            const scope = readRecord(scopeSpan, "scope");
            const spans = readArray(scopeSpan, "spans");
            for (const [spanIndex, rawSpan] of spans.entries()) {
                spanCount += 1;
                const spanWarnings = new Set();
                const span = normalizeSpan(rawSpan, spanWarnings);
                const common = commonEventFields(span, resourceIndex, scopeIndex, spanIndex, scope, spanWarnings);
                const mapped = mappedEvents(span, common, spanWarnings);
                if (mapped.length === 0) {
                    unknownSpans += 1;
                    spanWarnings.add("LOSSY_UNKNOWN_SPAN");
                    mapped.push({
                        ...common,
                        eventType: "unknown_span",
                        attributes: {
                            name: sanitizeText(span.name),
                            descriptorHash: common.descriptorHash,
                            sanitizedDescriptor: sanitizedSpanDescriptorJson(span, scope)
                        },
                        metrics: {}
                    });
                }
                for (const event of mapped) {
                    const redaction = countRedactions(event);
                    redactedValues += redaction;
                    if (redaction > 0) {
                        spanWarnings.add("VALUE_REDACTED");
                    }
                    const warnings = [...spanWarnings].sort();
                    warnings.forEach((warning) => warningCodes.add(warning));
                    events.push({
                        ...event,
                        eventId: `${event.eventId}:${event.eventType}`,
                        warnings
                    });
                }
            }
        }
    }
    if (spanCount === 0) {
        warningCodes.add("EMPTY_TRACE");
    }
    events.sort((left, right) => left.eventId.localeCompare(right.eventId));
    const manifestWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "trace_import_manifest",
        source: {
            ref: input.sourceRef,
            format: "otlp-json",
            otlpSchema: "resourceSpans.scopeSpans.spans",
            sourceHash
        },
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE",
        mapping: {
            name: "awb-otlp-diagnostic-import",
            version: "0.1.0",
            contentHash: mappingContentHash()
        },
        counts: {
            resourceSpans: resourceSpans.length,
            scopeSpans: scopeSpanCount,
            spans: spanCount,
            events: events.length,
            unknownSpans,
            redactedValues
        },
        warningCodes: [...warningCodes].sort(),
        redaction: {
            applied: redactedValues > 0,
            evidenceHash: sha256Text(stableJson({
                redactedValues,
                eventHashes: events.map((event) => event.descriptorHash)
            }))
        }
    };
    const manifest = {
        ...manifestWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(manifestWithoutIntegrity))
        }
    };
    const importWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "otlp_diagnostic_import",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE",
        mappingVersion: manifest.mapping.version,
        source: {
            ref: manifest.source.ref,
            sha256: manifest.source.sourceHash
        },
        manifest,
        events
    };
    return {
        ...importWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(importWithoutIntegrity))
        }
    };
}
export function assertTraceImportManifestIntegrity(manifest) {
    const { integrity, ...content } = manifest;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(content))) {
        throw new Error("Trace import manifest integrity verification failed.");
    }
}
export function assertOtlpDiagnosticImportIntegrity(value) {
    const { integrity, ...content } = value;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(content))) {
        throw new Error("OTLP diagnostic import integrity verification failed.");
    }
    assertTraceImportManifestIntegrity(value.manifest);
    const eventIds = value.events.map((event) => event.eventId);
    const warnings = new Set(value.events.flatMap((event) => event.warnings));
    if (value.events.length === 0) {
        warnings.add("EMPTY_TRACE");
    }
    const redactedValues = countRedactions(value.events);
    const expectedRedactionEvidenceHash = sha256Text(stableJson({
        redactedValues,
        eventHashes: value.events.map((event) => event.descriptorHash)
    }));
    if (value.schemaVersion !== "0.1.0" ||
        value.artifactType !== "otlp_diagnostic_import" ||
        value.status !== "DIAGNOSTIC_ONLY" ||
        value.gateAuthority !== "NONE" ||
        value.mappingVersion !== value.manifest.mapping.version ||
        value.manifest.mapping.contentHash !== mappingContentHash() ||
        value.source.ref !== value.manifest.source.ref ||
        value.source.sha256 !== value.manifest.source.sourceHash ||
        value.manifest.counts.events !== value.events.length ||
        value.manifest.counts.unknownSpans !==
            value.events.filter((event) => event.eventType === "unknown_span").length ||
        value.manifest.counts.redactedValues !== redactedValues ||
        value.manifest.redaction.applied !== (redactedValues > 0) ||
        value.manifest.redaction.evidenceHash !== expectedRedactionEvidenceHash ||
        new Set(eventIds).size !== eventIds.length ||
        stableJson(value.manifest.warningCodes) !==
            stableJson([...warnings].sort())) {
        throw new Error("OTLP diagnostic import bindings are inconsistent.");
    }
    assertPortableSourceRef(value.source.ref);
}
export function isSensitiveOtlpAttributeKey(key) {
    const parts = attributeKeyParts(key);
    const normalized = parts.join("");
    if (parts.includes("header") || parts.includes("headers")) {
        return true;
    }
    if (parts.includes("cookie") || parts.includes("cookies")) {
        return true;
    }
    if (normalized.startsWith("enduser")) {
        return true;
    }
    if (parts.includes("customer") || parts.includes("account") || parts.includes("session")) {
        return true;
    }
    if (parts.includes("user") &&
        !(parts.includes("agent") ||
            normalized === "useragent" ||
            normalized.endsWith("useragent"))) {
        return true;
    }
    const clientIndex = parts.indexOf("client");
    return (clientIndex >= 0 &&
        parts
            .slice(clientIndex + 1)
            .some((part) => part === "address" || part === "addr" || part === "ip"));
}
export function containsSensitiveOtlpAttributeKey(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveOtlpAttributeKey(key)) {
            return true;
        }
        if (containsSensitiveOtlpAttributeKey(item)) {
            return true;
        }
    }
    return false;
}
function mappedEvents(span, common, warnings) {
    const events = [];
    const attrs = span.attributes;
    const hasModel = attrs["gen_ai.request.model"] || attrs["gen_ai.response.model"];
    const hasHandoff = attrs["agent.handoff.from"] || attrs["agent.handoff.to"];
    const hasTool = attrs["tool.name"] || attrs["gen_ai.tool.name"];
    const hasEvaluation = attrs["evaluation.decision"] || attrs["evaluation.score"] !== undefined;
    const hasError = attrs["error.type"] || attrs["exception.type"] || attrs["error.message"];
    const tokenMetrics = compactNumbers({
        inputTokens: tokenCountAttr(attrs["gen_ai.usage.input_tokens"]),
        outputTokens: tokenCountAttr(attrs["gen_ai.usage.output_tokens"]),
        totalTokens: tokenCountAttr(attrs["gen_ai.usage.total_tokens"])
    });
    const hasTokens = Object.keys(tokenMetrics).length > 0;
    const isRecognizedSpan = Boolean(hasModel) ||
        Boolean(hasHandoff) ||
        Boolean(hasTool) ||
        Boolean(hasEvaluation) ||
        Boolean(hasError) ||
        hasTokens;
    if (!isRecognizedSpan) {
        return events;
    }
    if (hasModel) {
        events.push({
            ...common,
            eventType: "genai_model",
            attributes: compact({
                requestModel: stringAttr(attrs["gen_ai.request.model"]),
                responseModel: stringAttr(attrs["gen_ai.response.model"]),
                operation: stringAttr(attrs["gen_ai.operation.name"])
            }),
            metrics: {}
        });
    }
    if (hasHandoff) {
        events.push({
            ...common,
            eventType: "handoff",
            attributes: compact({
                from: stringAttr(attrs["agent.handoff.from"]),
                to: stringAttr(attrs["agent.handoff.to"])
            }),
            metrics: {}
        });
    }
    if (hasTool) {
        events.push({
            ...common,
            eventType: "tool_call",
            attributes: compact({
                toolName: stringAttr(attrs["tool.name"] ?? attrs["gen_ai.tool.name"])
            }),
            metrics: {}
        });
    }
    if (hasEvaluation) {
        events.push({
            ...common,
            eventType: "evaluation",
            attributes: compact({
                decision: stringAttr(attrs["evaluation.decision"]),
                score: numberAttr(attrs["evaluation.score"])
            }),
            metrics: {}
        });
    }
    if (hasTokens) {
        events.push({
            ...common,
            eventType: "token_usage",
            attributes: {},
            metrics: tokenMetrics
        });
    }
    else {
        warnings.add("MISSING_METRIC");
    }
    const durationMs = durationMilliseconds(span, warnings);
    events.push({
        ...common,
        eventType: durationMs === undefined ? "latency_unavailable" : "latency",
        attributes: {},
        metrics: durationMs === undefined ? {} : { durationMs }
    });
    if (hasError) {
        events.push({
            ...common,
            eventType: "error",
            attributes: compact({
                errorType: stringAttr(attrs["error.type"] ?? attrs["exception.type"]),
                message: stringAttr(attrs["error.message"])
            }),
            metrics: {}
        });
    }
    return events;
}
function commonEventFields(span, resourceIndex, scopeIndex, spanIndex, scope, warnings) {
    const timestamp = timestampFromNano(span.startUnixNano, warnings);
    const descriptor = sanitizeStructured({
        name: span.name,
        spanId: span.spanId,
        scopeName: readString(scope, "name"),
        scopeVersion: readString(scope, "version"),
        attributes: span.attributes
    });
    return {
        eventId: `otlp-${resourceIndex}-${scopeIndex}-${spanIndex}-${span.spanId}`,
        spanId: span.spanId,
        ...(stringAttr(span.attributes["agent.case_id"])
            ? { caseId: stringAttr(span.attributes["agent.case_id"]) }
            : {}),
        ...(stringAttr(span.attributes["agent.run_id"])
            ? { runId: stringAttr(span.attributes["agent.run_id"]) }
            : {}),
        ...(timestamp ? { timestamp } : {}),
        descriptorHash: sha256Text(stableJson(descriptor))
    };
}
function sanitizedSpanDescriptorJson(span, scope) {
    return stableJson(sanitizeStructured({
        name: span.name,
        spanId: span.spanId,
        scopeName: readString(scope, "name"),
        scopeVersion: readString(scope, "version"),
        attributes: span.attributes
    }));
}
function normalizeSpan(value, warnings) {
    const record = asRecord(value);
    const attrs = attributesToRecord(readArray(record, "attributes"));
    const rawSpanId = readString(record, "spanId");
    const spanId = rawSpanId && /^[a-f0-9]{16,32}$/iu.test(rawSpanId)
        ? rawSpanId.toLowerCase()
        : `invalid-${sha256Text(rawSpanId ?? "missing").slice("sha256:".length, 23)}`;
    if (!rawSpanId || spanId.startsWith("invalid-")) {
        warnings.add("INVALID_SPAN_ID");
    }
    return {
        spanId,
        name: readString(record, "name") ?? "unnamed-span",
        attributes: attrs,
        startTime: readString(record, "startTimeUnixNano"),
        endTime: readString(record, "endTimeUnixNano"),
        startUnixNano: parseNano(readString(record, "startTimeUnixNano")),
        endUnixNano: parseNano(readString(record, "endTimeUnixNano"))
    };
}
function attributesToRecord(attributes) {
    const result = {};
    for (const item of attributes) {
        const record = asRecord(item);
        const key = readString(record, "key");
        if (!key) {
            continue;
        }
        const value = asRecord(record.value);
        const normalized = readOtlpScalarValue(value);
        if (normalized === undefined) {
            continue;
        }
        result[key] = isSensitiveOtlpAttributeKey(key)
            ? "<redacted>"
            : normalizeScalar(normalized);
    }
    return sanitizeStructured(result);
}
function durationMilliseconds(span, warnings) {
    if (span.startTime && span.startUnixNano === undefined) {
        warnings.add("INVALID_TIMESTAMP");
    }
    if (span.endTime && span.endUnixNano === undefined) {
        warnings.add("INVALID_TIMESTAMP");
    }
    if (span.startUnixNano === undefined || span.endUnixNano === undefined) {
        warnings.add("MISSING_TIMESTAMP");
        return undefined;
    }
    if (unixNanoToDate(span.startUnixNano) === undefined ||
        unixNanoToDate(span.endUnixNano) === undefined) {
        warnings.add("INVALID_TIMESTAMP");
        return undefined;
    }
    if (span.endUnixNano < span.startUnixNano) {
        warnings.add("INVALID_TIMESTAMP");
        return undefined;
    }
    const durationMs = Number((span.endUnixNano - span.startUnixNano) / 1000000n);
    if (!Number.isSafeInteger(durationMs)) {
        warnings.add("INVALID_TIMESTAMP");
        return undefined;
    }
    return durationMs;
}
function timestampFromNano(value, warnings) {
    if (value === undefined) {
        warnings.add("MISSING_TIMESTAMP");
        return undefined;
    }
    const date = unixNanoToDate(value);
    if (!date) {
        warnings.add("INVALID_TIMESTAMP");
        return undefined;
    }
    return date.toISOString();
}
function unixNanoToDate(value) {
    const milliseconds = Number(value / 1000000n);
    if (!Number.isSafeInteger(milliseconds)) {
        return undefined;
    }
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date : undefined;
}
function parseNano(value) {
    if (!value || !/^\d+$/u.test(value)) {
        return undefined;
    }
    return BigInt(value);
}
function readArray(value, key) {
    const record = asRecord(value);
    const array = record[key];
    return Array.isArray(array) ? array : [];
}
function readRecord(value, key) {
    return asRecord(asRecord(value)[key]);
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function readString(value, key) {
    const item = value[key];
    return typeof item === "string" ? item : undefined;
}
function readOtlpScalarValue(value) {
    for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
        const item = value[key];
        if (typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean") {
            return item;
        }
    }
    return undefined;
}
function normalizeScalar(value) {
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) &&
            (!/^-?\d+$/u.test(value) || Number.isSafeInteger(numeric))) {
            return numeric;
        }
    }
    return sanitizeText(value);
}
function stringAttr(value) {
    return typeof value === "string" ? sanitizeText(value) : undefined;
}
function numberAttr(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function tokenCountAttr(value) {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}
function sanitizeText(value) {
    return redactSensitiveText(value);
}
function sanitizeStructured(value) {
    if (typeof value === "string") {
        return sanitizeText(value);
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeStructured);
    }
    if (value && typeof value === "object") {
        const sanitized = {};
        for (const [key, item] of Object.entries(value)) {
            const safeKey = sanitizeText(key);
            const uniqueKey = safeKey in sanitized
                ? `${safeKey}#${sha256Text(key).slice("sha256:".length, 15)}`
                : safeKey;
            sanitized[uniqueKey] = sanitizeStructured(item);
        }
        return sanitized;
    }
    return value;
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function compactNumbers(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function countRedactions(value) {
    return (stableJson(value).match(/<redacted>|<absolute-path>|<email>/gu) ?? [])
        .length;
}
function mappingContentHash() {
    return sha256Text(stableJson({
        mapping: "awb-otlp-diagnostic-import",
        version: "0.1.0",
        sensitiveAttributePolicy: [
            "enduser.*",
            "user/customer/account/session identifiers",
            "client address/ip",
            "headers/cookies"
        ],
        attributes: [
            "gen_ai.request.model",
            "gen_ai.response.model",
            "gen_ai.usage.*",
            "agent.handoff.*",
            "tool.name",
            "evaluation.*",
            "error.*"
        ]
    }));
}
function attributeKeyParts(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .split(/[^A-Za-z0-9]+/u)
        .flatMap((part) => part.split(/_/u))
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
}
function assertPortableSourceRef(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 512 ||
        value.startsWith("/") ||
        /^[A-Za-z]:/u.test(value) ||
        value.includes("\\") ||
        value.includes("://") ||
        value.split("/").includes("..")) {
        throw new Error("OTLP diagnostic import requires a portable source ref.");
    }
}
