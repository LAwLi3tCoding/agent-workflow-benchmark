import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertProductionTraceCurationIntegrity,
  buildProductionTraceCurationDraft,
  type ProductionTraceCurationInput
} from "../src/curation/productionTrace.js";
import { createAjv2020 } from "../src/utils/jsonSchema.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";
import { importOtlpDiagnosticTrace } from "../src/importers/otlp.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const syntheticAbsolutePath = (...segments: string[]): string =>
  ["", "home", "fixture-user", ...segments].join("/");

describe("production trace curation draft", () => {
  test("builds a deterministic diagnostic-only draft with minimized replay and known-good pairs", () => {
    const input = curationInput();
    const first = buildProductionTraceCurationDraft(input);
    const second = buildProductionTraceCurationDraft(input);

    expect(first).toEqual(second);
    expect(first.artifactType).toBe("production_trace_curation");
    expect(first.packageState).toBe("DRAFT");
    expect(first.status).toBe("DIAGNOSTIC_ONLY");
    expect(first.gateAuthority).toBe("NONE");
    expect(first.source).toMatchObject({
      ref: "trace-import.json",
      sha256: input.sourceImportHash,
      importContentHash: input.sourceImport.integrity.contentHash,
      mappingVersion: "0.1.0"
    });
    expect(first.replayCases).toHaveLength(1);
    expect(first.replayCases[0]).toMatchObject({
      draftCaseId: "prod-draft-case-payment-timeout",
      sourceFailureCode: "PAYMENT_TIMEOUT",
      sourceEventRefs: input.labels[0]!.sourceEventRefs,
      replayPrompt: {
        status: "MINIMIZED",
        variables: {
          workflowKind: "checkout-payment",
          expectedFailure: "PAYMENT_TIMEOUT"
        }
      },
      pairedKnownGoodCounterexample: {
        sourceEventRefs: input.labels[0]!.knownGoodEventRefs,
        variables: {
          workflowKind: "checkout-payment",
          expectedOutcome: "known-good"
        }
      }
    });
    expect(stableJson(first)).not.toContain("rawPayload");
    expect(stableJson(first)).not.toContain("customer-123");
    expect(first.reviewRequirements).toMatchObject({
      ownerReviewRequired: true,
      securityReviewRequired: true
    });
    expect(first.prerequisites.referenceRun.status).toBe("REQUIRED");
    expect(first.prerequisites.holdout.status).toBe("REQUIRED");
    assertProductionTraceCurationIntegrity(first);
  });

  test("fails closed on raw secrets, absolute paths, company paths, or direct identifiers", () => {
    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: traceImport({
            events: [
              traceEvent("evt-fail", {
                attributes: { note: "Bearer secret-token-12345" }
              }),
              traceEvent("evt-good", { attributes: { status: "ok" } })
            ]
          })
        })
      )
    ).toThrow(/unredacted sensitive/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: traceImport({
            events: [
              traceEvent("evt-fail", {
                attributes: {
                  file: syntheticAbsolutePath("company", "private.txt")
                }
              }),
              traceEvent("evt-good", { attributes: { status: "ok" } })
            ]
          })
        })
      )
    ).toThrow(/unredacted sensitive/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: traceImport({
            events: [
              traceEvent("evt-fail", {
                attributes: { customerId: "customer-123" }
              }),
              traceEvent("evt-good", { attributes: { status: "ok" } })
            ]
          })
        })
      )
    ).toThrow(/direct customer or user identifier/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: traceImport({
            events: [
              traceEvent("evt-fail", {
                attributes: { sessionId: "session-raw-123" }
              }),
              traceEvent("evt-good", { attributes: { status: "ok" } })
            ]
          })
        })
      )
    ).toThrow(/sensitive OTLP attributes/i);
  });

  test("rejects activation attempts and missing consent retention or redaction evidence", () => {
    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({ requestedPackageState: "ACTIVE" })
      )
    ).toThrow(/draft-only/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          consent: { ...curationInput().consent, evidenceRefs: [] }
        })
      )
    ).toThrow(/consent evidence/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          retention: { ...curationInput().retention, expiresAt: "" }
        })
      )
    ).toThrow(/retention/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          redactionReview: {
            ...curationInput().redactionReview,
            evidenceRefs: []
          }
        })
      )
    ).toThrow(/redaction review/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({ generatedAt: undefined as never })
      )
    ).toThrow(/generatedAt/iu);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({ generatedAt: "2026-09-01T00:00:00.000Z" })
      )
    ).toThrow(/expired/iu);
  });

  test("rejects non-diagnostic imports, source hash mismatches, duplicate source hashes, and missing known-good pairs", () => {
    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: {
            ...curationInput().sourceImport,
            status: "PASS"
          } as unknown as ProductionTraceCurationInput["sourceImport"]
        })
      )
    ).toThrow(/DIAGNOSTIC_ONLY/);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({ sourceImportHash: HASH_B })
      )
    ).toThrow(/source import hash/i);

    const base = curationInput();
    expect(() =>
      buildProductionTraceCurationDraft({
        ...base,
        additionalSourceImportHashes: [base.sourceImportHash]
      })
    ).toThrow(/duplicate source hash/i);

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          labels: [
            {
              ...curationInput().labels[0]!,
              knownGoodEventRefs: []
            }
          ]
        })
      )
    ).toThrow(/known-good counterexample/i);

    const duplicateEvents = traceImport({
      events: [
        traceEvent("evt-fail", {}),
        traceEvent("evt-good", { eventId: "evt-fail" })
      ]
    });
    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: duplicateEvents,
          labels: [
            {
              ...curationInput().labels[0]!,
              knownGoodEventRefs: ["trace-import.json#event=evt-fail"]
            }
          ]
        })
      )
    ).toThrow(/duplicate event id|disjoint|bindings are inconsistent/iu);
  });

  test("accepts the first-party OTLP import contract without reshaping or trust promotion", () => {
    const sourceImport = importOtlpDiagnosticTrace({
      sourceRef: "production-redacted.json",
      otlp: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                scope: { name: "production-fixture" },
                spans: [
                  {
                    spanId: "abcdef0123456789",
                    name: "failure",
                    attributes: [
                      {
                        key: "error.type",
                        value: { stringValue: "Timeout" }
                      },
                      {
                        key: "sessionId",
                        value: { stringValue: "raw-session-123" }
                      }
                    ]
                  },
                  {
                    spanId: "fedcba9876543210",
                    name: "known-good",
                    attributes: [
                      {
                        key: "evaluation.decision",
                        value: { stringValue: "PASS" }
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const failureEvent = sourceImport.events.find(
      (event) => event.eventType === "error"
    )!;
    const knownGoodEvent = sourceImport.events.find(
      (event) => event.eventType === "evaluation"
    )!;
    const report = buildProductionTraceCurationDraft(
      curationInput({
        sourceImport,
        taxonomy: {
          ...curationInput().taxonomy,
          mappingVersion: sourceImport.mappingVersion
        },
        labels: [
          {
            ...curationInput().labels[0]!,
            sourceEventRefs: [
              `trace-import.json#event=${failureEvent.eventId}`
            ],
            knownGoodEventRefs: [
              `trace-import.json#event=${knownGoodEvent.eventId}`
            ]
          }
        ]
      })
    );

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.gateAuthority).toBe("NONE");
    expect(report.source.mappingVersion).toBe("0.1.0");
    expect(stableJson(report)).not.toContain("raw-session-123");
  });

  test("revalidates embedded first-party OTLP manifest integrity during curation", () => {
    const sourceImport = importOtlpDiagnosticTrace({
      sourceRef: "production-redacted.json",
      otlp: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    spanId: "abcdef0123456789",
                    name: "failure",
                    attributes: [
                      {
                        key: "error.type",
                        value: { stringValue: "Timeout" }
                      }
                    ]
                  },
                  {
                    spanId: "fedcba9876543210",
                    name: "known-good",
                    attributes: [
                      {
                        key: "evaluation.decision",
                        value: { stringValue: "PASS" }
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const failureEvent = sourceImport.events.find(
      (event) => event.eventType === "error"
    )!;
    const knownGoodEvent = sourceImport.events.find(
      (event) => event.eventType === "evaluation"
    )!;
    const tampered = structuredClone(sourceImport);
    tampered.manifest.mapping.contentHash = HASH_B;
    const { integrity: _integrity, ...content } = tampered;
    tampered.integrity.contentHash = sha256Text(stableJson(content));

    expect(() =>
      buildProductionTraceCurationDraft(
        curationInput({
          sourceImport: tampered,
          taxonomy: {
            ...curationInput().taxonomy,
            mappingVersion: tampered.mappingVersion
          },
          labels: [
            {
              ...curationInput().labels[0]!,
              sourceEventRefs: [
                `trace-import.json#event=${failureEvent.eventId}`
              ],
              knownGoodEventRefs: [
                `trace-import.json#event=${knownGoodEvent.eventId}`
              ]
            }
          ]
        })
      )
    ).toThrow(/manifest integrity|bindings are inconsistent/iu);
  });

  test("validates schema and detects integrity tampering", async () => {
    const input = curationInput();
    const report = buildProductionTraceCurationDraft(input);
    const inputSchema = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "schemas/production-trace-curation-input.schema.json"
        ),
        "utf8"
      )
    );
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas/production-trace-curation.schema.json"),
        "utf8"
      )
    );
    const ajv = createAjv2020();
    const validateInput = ajv.compile(inputSchema);
    const validate = ajv.compile(schema);

    expect(
      validateInput(input),
      ajv.errorsText(validateInput.errors)
    ).toBe(true);
    const wrongImportType = structuredClone(input) as unknown as Record<
      string,
      unknown
    >;
    (wrongImportType.sourceImport as Record<string, unknown>).artifactType =
      "wrong_import_type";
    expect(validateInput(wrongImportType)).toBe(false);
    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
    const tampered = structuredClone(report);
    tampered.replayCases[0]!.sourceFailureCode = "OTHER";
    expect(() => assertProductionTraceCurationIntegrity(tampered)).toThrow(
      /integrity/i
    );
  });
});

function curationInput(
  overrides: Partial<ProductionTraceCurationInput> = {}
): ProductionTraceCurationInput {
  const sourceImport = overrides.sourceImport ?? traceImport();
  const failureEvent = sourceImport.events.find(
    (event) => event.eventType === "error"
  )!;
  const knownGoodEvent = sourceImport.events.find(
    (event) => event.eventType === "evaluation"
  )!;
  return {
    sourceImport,
    sourceImportRef: "trace-import.json",
    taxonomy: {
      mappingVersion: sourceImport.mappingVersion,
      failureTaxonomyVersion: "payments-v1",
      labelsVersion: "labels-v1"
    },
    labels: [
      {
        failureCode: "PAYMENT_TIMEOUT",
        category: "external_dependency",
        severity: "P1",
        workflowKind: "checkout-payment",
        sourceEventRefs: [
          `trace-import.json#event=${failureEvent.eventId}`
        ],
        knownGoodEventRefs: [
          `trace-import.json#event=${knownGoodEvent.eventId}`
        ],
        expectedBehavior: "Payment retry path should time out cleanly.",
        minimizedInputs: {
          workflowKind: "checkout-payment",
          expectedFailure: "PAYMENT_TIMEOUT"
        },
        knownGoodInputs: {
          workflowKind: "checkout-payment",
          expectedOutcome: "known-good"
        }
      }
    ],
    consent: {
      scope: "benchmark_curation_draft",
      grantedBy: "privacy-review",
      grantedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-08-26T00:00:00.000Z",
      allowedUses: ["diagnostic_replay_draft"],
      evidenceRefs: ["privacy-ticket-1"]
    },
    retention: {
      policyRef: "retention-policy-v1",
      expiresAt: "2026-08-26T00:00:00.000Z"
    },
    redactionReview: {
      redactedOnly: true,
      reviewedBy: "security-review",
      reviewedAt: "2026-07-26T00:00:00.000Z",
      evidenceRefs: ["redaction-report-1"],
      policyVersion: "redaction-v1"
    },
    ownerReview: {
      requiredReviewers: ["payments-owner"],
      requirement: "Owner must approve minimized replay semantics."
    },
    securityReview: {
      requiredReviewers: ["appsec"],
      requirement: "Security must approve redaction and retention scope."
    },
    prerequisites: {
      referenceRun: {
        required: true,
        requirement: "Run known-good reference before promotion."
      },
      holdout: {
        required: true,
        requirement: "Keep curated draft out of holdout labels until reviewed."
      }
    },
    generatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
    sourceImportHash:
      overrides.sourceImportHash ?? sha256Text(stableJson(sourceImport))
  };
}

function traceImport(
  overrides: Partial<ProductionTraceCurationInput["sourceImport"]> = {}
): ProductionTraceCurationInput["sourceImport"] {
  const imported = importOtlpDiagnosticTrace({
    sourceRef: "prod-otlp-redacted.json",
    otlp: {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "aaaaaaaaaaaaaaaa",
                  name: "payment-timeout",
                  attributes: [
                    {
                      key: "error.type",
                      value: { stringValue: "PAYMENT_TIMEOUT" }
                    }
                  ]
                },
                {
                  spanId: "bbbbbbbbbbbbbbbb",
                  name: "payment-success",
                  attributes: [
                    {
                      key: "evaluation.decision",
                      value: { stringValue: "PASS" }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  });
  const withoutIntegrity = {
    ...imported,
    ...overrides
  } as ProductionTraceCurationInput["sourceImport"];
  const { integrity: _integrity, ...content } = withoutIntegrity;
  return {
    ...content,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      contentHash: sha256Text(stableJson(content))
    }
  };
}

function traceEvent(
  eventId: string,
  overrides: Partial<ProductionTraceCurationInput["sourceImport"]["events"][number]>
): ProductionTraceCurationInput["sourceImport"]["events"][number] {
  return {
    eventId,
    eventType: eventId === "evt-good" ? "evaluation" : "error",
    spanId:
      eventId === "evt-good"
        ? "bbbbbbbbbbbbbbbb"
        : "aaaaaaaaaaaaaaaa",
    caseId: "case-prod",
    timestamp: "2026-07-26T00:00:00.000Z",
    attributes: {},
    metrics: {},
    descriptorHash: HASH_B,
    warnings: [],
    ...overrides
  };
}
