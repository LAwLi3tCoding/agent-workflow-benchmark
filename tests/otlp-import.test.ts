import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAjv2020 } from "../src/utils/jsonSchema.js";
import {
  assertOtlpDiagnosticImportIntegrity,
  assertTraceImportManifestIntegrity,
  importOtlpDiagnosticTrace
} from "../src/importers/otlp.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";

const syntheticAbsolutePath = (...segments: string[]): string =>
  ["", "home", "fixture-user", ...segments].join("/");

describe("OTLP diagnostic trace import", () => {
  test("maps GenAI, agent, handoff, tool, eval, token, latency, and error attributes", () => {
    const report = importOtlpDiagnosticTrace({
      sourceRef: "fixtures/otlp.json",
      otlp: fixtureOtlp([
        span(
          "s1",
          "agent.run",
          {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.usage.input_tokens": 120,
            "gen_ai.usage.output_tokens": 45,
            "gen_ai.usage.total_tokens": 165,
            "agent.case_id": "case-route",
            "agent.run_id": "run-1",
            "agent.handoff.from": "planner",
            "agent.handoff.to": "executor",
            "tool.name": "apply_patch",
            "evaluation.decision": "BLOCK",
            "evaluation.score": 0.42,
            "error.type": "PolicyViolation"
          },
          "2026-07-27T00:00:00.000Z",
          "2026-07-27T00:00:03.250Z"
        )
      ])
    });

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.gateAuthority).toBe("NONE");
    expect(report).toMatchObject({
      mappingVersion: "0.1.0",
      source: {
        ref: "fixtures/otlp.json",
        sha256: report.manifest.source.sourceHash
      },
      integrity: {
        status: "VERIFIED_AT_WRITE"
      }
    });
    expect(report.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "genai_model",
          caseId: "case-route",
          runId: "run-1",
          attributes: expect.objectContaining({
            requestModel: "gpt-5.5",
            responseModel: "gpt-5.5"
          })
        }),
        expect.objectContaining({
          eventType: "handoff",
          attributes: { from: "planner", to: "executor" }
        }),
        expect.objectContaining({
          eventType: "tool_call",
          attributes: { toolName: "apply_patch" }
        }),
        expect.objectContaining({
          eventType: "evaluation",
          attributes: expect.objectContaining({
            decision: "BLOCK",
            score: 0.42
          })
        }),
        expect.objectContaining({
          eventType: "token_usage",
          metrics: { inputTokens: 120, outputTokens: 45, totalTokens: 165 }
        }),
        expect.objectContaining({
          eventType: "latency",
          metrics: { durationMs: 3250 }
        }),
        expect.objectContaining({
          eventType: "error",
          attributes: { errorType: "PolicyViolation" }
        })
      ])
    );
    expect(report.manifest.warningCodes).not.toContain(
      "TRUSTED_OBSERVER_UNSUPPORTED"
    );
    expect(stableJson(report)).not.toContain("attestation");
    expect(stableJson(report)).not.toContain("qualification");
    assertTraceImportManifestIntegrity(report.manifest);
    assertOtlpDiagnosticImportIntegrity(report);
  });

  test("rejects recomputed wrapper hashes when manifest bindings disagree", () => {
    const report = importOtlpDiagnosticTrace({
      sourceRef: "binding.json",
      otlp: fixtureOtlp([
        span("abcdef0123456789", "agent.run", {
          "gen_ai.request.model": "gpt-5.5"
        })
      ])
    });
    const tampered = structuredClone(report);
    tampered.source.sha256 = `sha256:${"f".repeat(64)}`;
    const { integrity: _integrity, ...content } = tampered;
    tampered.integrity.contentHash = sha256Text(stableJson(content));

    expect(() => assertOtlpDiagnosticImportIntegrity(tampered)).toThrow(
      /bindings are inconsistent/iu
    );
  });

  test("keeps unknown spans as sanitized descriptors and lossy content hashes", () => {
    const localPath = syntheticAbsolutePath("company", "private.txt");
    const report = importOtlpDiagnosticTrace({
      sourceRef: "unknown.json",
      otlp: fixtureOtlp([
        span("s-unknown", "custom.internal.step", {
          "custom.payload": "Bearer secret-token-12345",
          "log.file": localPath
        })
      ])
    });

    expect(report.manifest.warningCodes).toEqual(
      expect.arrayContaining(["LOSSY_UNKNOWN_SPAN", "MISSING_TIMESTAMP"])
    );
    expect(report.events).toContainEqual(
      expect.objectContaining({
        eventType: "unknown_span",
        attributes: expect.objectContaining({
          name: "custom.internal.step",
          descriptorHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
        })
      })
    );
    const serialized = stableJson(report);
    expect(serialized).not.toContain("secret-token-12345");
    expect(serialized).not.toContain(localPath);
    expect(serialized).toContain("<redacted>");
    expect(serialized).toContain("<absolute-path>");
  });

  test("redacts sensitive OTLP attributes by key across dotted snake and camel variants", () => {
    const report = importOtlpDiagnosticTrace({
      sourceRef: "sensitive-keys.json",
      otlp: fixtureOtlp([
        span("abcdef0123456789", "custom.internal.step", {
          "enduser.id": "enduser-123",
          user_id: "user-456",
          customerId: "customer-789",
          accountNumber: "acct-0001",
          sessionToken: "session-token-1",
          clientAddress: "203.0.113.10",
          "http.request.header.authorization": "Bearer live-token",
          cookie: "sid=raw-cookie",
          user_agent: "safe-browser-agent"
        })
      ])
    });

    const serialized = stableJson(report);
    for (const value of [
      "enduser-123",
      "user-456",
      "customer-789",
      "acct-0001",
      "session-token-1",
      "203.0.113.10",
      "Bearer live-token",
      "sid=raw-cookie"
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain("safe-browser-agent");
    expect(report.manifest.counts.redactedValues).toBeGreaterThanOrEqual(8);
    expect(report.manifest.warningCodes).toContain("VALUE_REDACTED");
    assertOtlpDiagnosticImportIntegrity(report);
  });

  test("is deterministic and records missing timestamps and metrics instead of fabricating them", () => {
    const otlp = fixtureOtlp([
      span("s-missing", "agent.run", {
        "agent.case_id": "case-missing",
        "gen_ai.request.model": "gpt-5.5"
      })
    ]);

    const first = importOtlpDiagnosticTrace({ sourceRef: "same.json", otlp });
    const second = importOtlpDiagnosticTrace({ sourceRef: "same.json", otlp });

    expect(first).toEqual(second);
    expect(first.manifest.warningCodes).toEqual(
      expect.arrayContaining(["MISSING_TIMESTAMP", "MISSING_METRIC"])
    );
    expect(first.events).toContainEqual(
      expect.objectContaining({
        eventType: "latency_unavailable",
        metrics: {}
      })
    );
  });

  test("fails closed on non-portable refs and sanitizes hostile span ids and attribute keys", () => {
    const sourceRef = syntheticAbsolutePath("private", "trace.json");
    expect(() =>
      importOtlpDiagnosticTrace({
        sourceRef,
        otlp: fixtureOtlp([])
      })
    ).toThrow(/portable source ref/iu);

    const localPath = syntheticAbsolutePath("private.txt");
    const hostile = importOtlpDiagnosticTrace({
      sourceRef: "hostile.json",
      otlp: fixtureOtlp([
        span("Bearer secret-span-token", "custom.step", {
          "Bearer secret-attribute-key": "safe",
          "custom.file": localPath
        })
      ])
    });
    const serialized = stableJson(hostile);
    expect(serialized).not.toContain("secret-span-token");
    expect(serialized).not.toContain("secret-attribute-key");
    expect(serialized).not.toContain(localPath);
    expect(hostile.manifest.warningCodes).toEqual(
      expect.arrayContaining(["INVALID_SPAN_ID", "VALUE_REDACTED"])
    );
  });

  test("reports empty and out-of-range timestamp input instead of throwing or inventing time", () => {
    const empty = importOtlpDiagnosticTrace({
      sourceRef: "empty.json",
      otlp: fixtureOtlp([])
    });
    expect(empty.manifest.warningCodes).toContain("EMPTY_TRACE");
    expect(empty.events).toEqual([]);

    const invalid = importOtlpDiagnosticTrace({
      sourceRef: "invalid-time.json",
      otlp: fixtureOtlp([
        {
          ...span("abcdef0123456789", "agent.run", {
            "gen_ai.request.model": "gpt-5.5"
          }),
          startTimeUnixNano: "999999999999999999999999999999999999",
          endTimeUnixNano: "999999999999999999999999999999999999"
        }
      ])
    });
    expect(invalid.manifest.warningCodes).toContain("INVALID_TIMESTAMP");
    const unavailable = invalid.events.find(
      (event) => event.eventType === "latency_unavailable"
    );
    expect(unavailable).toBeDefined();
    expect(unavailable).not.toHaveProperty("timestamp");
  });

  test("does not publish negative or precision-losing token counts", () => {
    const report = importOtlpDiagnosticTrace({
      sourceRef: "invalid-tokens.json",
      otlp: fixtureOtlp([
        span("abcdef0123456789", "agent.run", {
          "gen_ai.request.model": "gpt-5.5",
          "gen_ai.usage.input_tokens": -1,
          "gen_ai.usage.output_tokens": "9007199254740993"
        })
      ])
    });

    expect(report.manifest.warningCodes).toContain("MISSING_METRIC");
    expect(
      report.events.some((event) => event.eventType === "token_usage")
    ).toBe(false);
  });

  test("validates the diagnostic import and manifest schemas", async () => {
    const report = importOtlpDiagnosticTrace({
      sourceRef: "schema.json",
      otlp: fixtureOtlp([
        span(
          "s-schema",
          "gen_ai.request",
          {
            "gen_ai.request.model": "gpt-5.5"
          },
          "2026-07-27T00:00:00.000Z",
          "2026-07-27T00:00:00.010Z"
        )
      ])
    });
    const ajv = createAjv2020();
    for (const [schemaFile, value] of [
      ["otlp-diagnostic-import.schema.json", report],
      ["trace-import-manifest.schema.json", report.manifest]
    ] as const) {
      const schema = JSON.parse(
        await readFile(path.join(process.cwd(), "schemas", schemaFile), "utf8")
      );
      const validate = ajv.compile(schema);
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
    }
  });
});

function fixtureOtlp(spans: Array<Record<string, unknown>>) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "awb-test"),
            attr("telemetry.sdk.language", "nodejs")
          ]
        },
        scopeSpans: [
          {
            scope: { name: "fixture-scope", version: "1.0.0" },
            spans
          }
        ]
      }
    ]
  };
}

function span(
  spanId: string,
  name: string,
  attributes: Record<string, unknown>,
  startTime?: string,
  endTime?: string
) {
  return {
    traceId: "0".repeat(32),
    spanId,
    name,
    ...(startTime ? { startTimeUnixNano: dateToNano(startTime) } : {}),
    ...(endTime ? { endTimeUnixNano: dateToNano(endTime) } : {}),
    attributes: Object.entries(attributes).map(([key, value]) => attr(key, value))
  };
}

function attr(key: string, value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

function dateToNano(value: string): string {
  return `${BigInt(Date.parse(value)) * 1_000_000n}`;
}
