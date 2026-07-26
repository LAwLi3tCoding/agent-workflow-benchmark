import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type TraceImportWarningCode =
  | "LOSSY_UNKNOWN_SPAN"
  | "MISSING_TIMESTAMP"
  | "INVALID_TIMESTAMP"
  | "INVALID_SPAN_ID"
  | "MISSING_METRIC"
  | "VALUE_REDACTED"
  | "EMPTY_TRACE";

export interface OtlpDiagnosticEvent {
  eventId: string;
  eventType:
    | "genai_model"
    | "handoff"
    | "tool_call"
    | "evaluation"
    | "token_usage"
    | "latency"
    | "latency_unavailable"
    | "error"
    | "unknown_span";
  spanId: string;
  caseId?: string;
  runId?: string;
  timestamp?: string;
  attributes: Record<string, string | number | boolean>;
  metrics: Record<string, number>;
  descriptorHash: string;
  warnings: TraceImportWarningCode[];
}

export interface TraceImportManifest {
  schemaVersion: "0.1.0";
  artifactType: "trace_import_manifest";
  source: {
    ref: string;
    format: "otlp-json";
    otlpSchema: "resourceSpans.scopeSpans.spans";
    sourceHash: string;
  };
  status: "DIAGNOSTIC_ONLY";
  gateAuthority: "NONE";
  mapping: {
    name: "awb-otlp-diagnostic-import";
    version: "0.1.0";
    contentHash: string;
  };
  counts: {
    resourceSpans: number;
    scopeSpans: number;
    spans: number;
    events: number;
    unknownSpans: number;
    redactedValues: number;
  };
  warningCodes: TraceImportWarningCode[];
  redaction: {
    applied: boolean;
    evidenceHash: string;
  };
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export interface OtlpDiagnosticImport {
  schemaVersion: "0.1.0";
  artifactType: "otlp_diagnostic_import";
  status: "DIAGNOSTIC_ONLY";
  gateAuthority: "NONE";
  mappingVersion: "0.1.0";
  source: {
    ref: string;
    sha256: string;
  };
  manifest: TraceImportManifest;
  events: OtlpDiagnosticEvent[];
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
}

export function importOtlpDiagnosticTrace(input: {
  sourceRef: string;
  otlp: unknown;
}): OtlpDiagnosticImport {
  assertPortableSourceRef(input.sourceRef);
  const sourceHash = sha256Text(stableJson(input.otlp));
  const resourceSpans = readArray(input.otlp, "resourceSpans");
  const events: OtlpDiagnosticEvent[] = [];
  let scopeSpanCount = 0;
  let spanCount = 0;
  let unknownSpans = 0;
  let redactedValues = 0;
  const warningCodes = new Set<TraceImportWarningCode>();

  for (const [resourceIndex, resourceSpan] of resourceSpans.entries()) {
    const scopeSpans = readArray(resourceSpan, "scopeSpans");
    scopeSpanCount += scopeSpans.length;
    for (const [scopeIndex, scopeSpan] of scopeSpans.entries()) {
      const scope = readRecord(scopeSpan, "scope");
      const spans = readArray(scopeSpan, "spans");
      for (const [spanIndex, rawSpan] of spans.entries()) {
        spanCount += 1;
        const spanWarnings = new Set<TraceImportWarningCode>();
        const span = normalizeSpan(rawSpan, spanWarnings);
        const common = commonEventFields(
          span,
          resourceIndex,
          scopeIndex,
          spanIndex,
          scope,
          spanWarnings
        );
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
    schemaVersion: "0.1.0" as const,
    artifactType: "trace_import_manifest" as const,
    source: {
      ref: input.sourceRef,
      format: "otlp-json" as const,
      otlpSchema: "resourceSpans.scopeSpans.spans" as const,
      sourceHash
    },
    status: "DIAGNOSTIC_ONLY" as const,
    gateAuthority: "NONE" as const,
    mapping: {
      name: "awb-otlp-diagnostic-import" as const,
      version: "0.1.0" as const,
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
      evidenceHash: sha256Text(
        stableJson({
          redactedValues,
          eventHashes: events.map((event) => event.descriptorHash)
        })
      )
    }
  };
  const manifest: TraceImportManifest = {
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
  } as const;
  return {
    ...importWithoutIntegrity,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(importWithoutIntegrity))
    }
  };
}

export function assertTraceImportManifestIntegrity(
  manifest: TraceImportManifest
): void {
  const { integrity, ...content } = manifest;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("Trace import manifest integrity verification failed.");
  }
}

export function assertOtlpDiagnosticImportIntegrity(
  value: OtlpDiagnosticImport
): void {
  const { integrity, ...content } = value;
  if (
    integrity.status !== "VERIFIED_AT_WRITE" ||
    integrity.contentHash !== sha256Text(stableJson(content))
  ) {
    throw new Error("OTLP diagnostic import integrity verification failed.");
  }
  assertTraceImportManifestIntegrity(value.manifest);
  const eventIds = value.events.map((event) => event.eventId);
  const warnings = new Set(
    value.events.flatMap((event) => event.warnings)
  );
  if (value.events.length === 0) {
    warnings.add("EMPTY_TRACE");
  }
  const redactedValues = countRedactions(value.events);
  const expectedRedactionEvidenceHash = sha256Text(
    stableJson({
      redactedValues,
      eventHashes: value.events.map((event) => event.descriptorHash)
    })
  );
  if (
    value.schemaVersion !== "0.1.0" ||
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
      stableJson([...warnings].sort())
  ) {
    throw new Error("OTLP diagnostic import bindings are inconsistent.");
  }
  assertPortableSourceRef(value.source.ref);
}

export function isSensitiveOtlpAttributeKey(key: string): boolean {
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
  if (
    parts.includes("user") &&
    !(
      parts.includes("agent") ||
      normalized === "useragent" ||
      normalized.endsWith("useragent")
    )
  ) {
    return true;
  }
  const clientIndex = parts.indexOf("client");
  return (
    clientIndex >= 0 &&
    parts
      .slice(clientIndex + 1)
      .some((part) => part === "address" || part === "addr" || part === "ip")
  );
}

export function containsSensitiveOtlpAttributeKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveOtlpAttributeKey(key)) {
      return true;
    }
    if (containsSensitiveOtlpAttributeKey(item)) {
      return true;
    }
  }
  return false;
}

interface NormalizedSpan {
  spanId: string;
  name: string;
  attributes: Record<string, string | number | boolean>;
  startTime?: string;
  endTime?: string;
  startUnixNano?: bigint;
  endUnixNano?: bigint;
}

type EventBase = Omit<
  OtlpDiagnosticEvent,
  "eventType" | "attributes" | "metrics" | "warnings"
>;

function mappedEvents(
  span: NormalizedSpan,
  common: EventBase,
  warnings: Set<TraceImportWarningCode>
): Array<Omit<OtlpDiagnosticEvent, "warnings">> {
  const events: Array<Omit<OtlpDiagnosticEvent, "warnings">> = [];
  const attrs = span.attributes;
  const hasModel =
    attrs["gen_ai.request.model"] || attrs["gen_ai.response.model"];
  const hasHandoff = attrs["agent.handoff.from"] || attrs["agent.handoff.to"];
  const hasTool = attrs["tool.name"] || attrs["gen_ai.tool.name"];
  const hasEvaluation =
    attrs["evaluation.decision"] || attrs["evaluation.score"] !== undefined;
  const hasError =
    attrs["error.type"] || attrs["exception.type"] || attrs["error.message"];
  const tokenMetrics = compactNumbers({
    inputTokens: tokenCountAttr(attrs["gen_ai.usage.input_tokens"]),
    outputTokens: tokenCountAttr(attrs["gen_ai.usage.output_tokens"]),
    totalTokens: tokenCountAttr(attrs["gen_ai.usage.total_tokens"])
  });
  const hasTokens = Object.keys(tokenMetrics).length > 0;
  const isRecognizedSpan =
    Boolean(hasModel) ||
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
  } else {
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

function commonEventFields(
  span: NormalizedSpan,
  resourceIndex: number,
  scopeIndex: number,
  spanIndex: number,
  scope: Record<string, unknown>,
  warnings: Set<TraceImportWarningCode>
): EventBase {
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

function sanitizedSpanDescriptorJson(
  span: NormalizedSpan,
  scope: Record<string, unknown>
): string {
  return stableJson(
    sanitizeStructured({
      name: span.name,
      spanId: span.spanId,
      scopeName: readString(scope, "name"),
      scopeVersion: readString(scope, "version"),
      attributes: span.attributes
    })
  );
}

function normalizeSpan(
  value: unknown,
  warnings: Set<TraceImportWarningCode>
): NormalizedSpan {
  const record = asRecord(value);
  const attrs = attributesToRecord(readArray(record, "attributes"));
  const rawSpanId = readString(record, "spanId");
  const spanId =
    rawSpanId && /^[a-f0-9]{16,32}$/iu.test(rawSpanId)
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

function attributesToRecord(
  attributes: unknown[]
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
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
  return sanitizeStructured(result) as Record<
    string,
    string | number | boolean
  >;
}

function durationMilliseconds(
  span: NormalizedSpan,
  warnings: Set<TraceImportWarningCode>
): number | undefined {
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
  if (
    unixNanoToDate(span.startUnixNano) === undefined ||
    unixNanoToDate(span.endUnixNano) === undefined
  ) {
    warnings.add("INVALID_TIMESTAMP");
    return undefined;
  }
  if (span.endUnixNano < span.startUnixNano) {
    warnings.add("INVALID_TIMESTAMP");
    return undefined;
  }
  const durationMs = Number(
    (span.endUnixNano - span.startUnixNano) / 1_000_000n
  );
  if (!Number.isSafeInteger(durationMs)) {
    warnings.add("INVALID_TIMESTAMP");
    return undefined;
  }
  return durationMs;
}

function timestampFromNano(
  value: bigint | undefined,
  warnings: Set<TraceImportWarningCode>
): string | undefined {
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

function unixNanoToDate(value: bigint): Date | undefined {
  const milliseconds = Number(value / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds)) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function parseNano(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  return BigInt(value);
}

function readArray(value: unknown, key: string): unknown[] {
  const record = asRecord(value);
  const array = record[key];
  return Array.isArray(array) ? array : [];
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(value)[key]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function readOtlpScalarValue(
  value: Record<string, unknown>
): string | number | boolean | undefined {
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    const item = value[key];
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      return item;
    }
  }
  return undefined;
}

function normalizeScalar(
  value: string | number | boolean
): string | number | boolean {
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
    if (
      Number.isFinite(numeric) &&
      (!/^-?\d+$/u.test(value) || Number.isSafeInteger(numeric))
    ) {
      return numeric;
    }
  }
  return sanitizeText(value);
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizeText(value) : undefined;
}

function numberAttr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenCountAttr(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function sanitizeText(value: string): string {
  return redactSensitiveText(value);
}

function sanitizeStructured(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeStructured);
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      const safeKey = sanitizeText(key);
      const uniqueKey =
        safeKey in sanitized
          ? `${safeKey}#${sha256Text(key).slice("sha256:".length, 15)}`
          : safeKey;
      sanitized[uniqueKey] = sanitizeStructured(item);
    }
    return sanitized;
  }
  return value;
}

function compact(
  value: Record<string, string | number | boolean | undefined>
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Record<string, string | number | boolean>;
}

function compactNumbers(
  value: Record<string, number | undefined>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Record<string, number>;
}

function countRedactions(value: unknown): number {
  return (stableJson(value).match(/<redacted>|<absolute-path>|<email>/gu) ?? [])
    .length;
}

function mappingContentHash(): string {
  return sha256Text(
    stableJson({
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
    })
  );
}

function attributeKeyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .flatMap((part) => part.split(/_/u))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function assertPortableSourceRef(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("://") ||
    value.split("/").includes("..")
  ) {
    throw new Error("OTLP diagnostic import requires a portable source ref.");
  }
}
