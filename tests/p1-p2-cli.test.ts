import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  importOtlpDiagnosticTrace,
  type OtlpDiagnosticImport
} from "../src/importers/otlp.js";
import type { ProductionTraceCurationInput } from "../src/curation/productionTrace.js";
import type { BenchmarkGovernanceInput } from "../src/governance/publicBenchmark.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";

const cwd = process.cwd();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

describe("P1/P2 diagnostic CLI commands", () => {
  test("trace import-otlp writes diagnostic-only import artifacts and exits 2", async () => {
    const dir = await tmp("awb-otlp-cli-");
    try {
      const input = path.join(dir, "input.json");
      const out = path.join(dir, "out");
      await writeJson(input, otlpFixture());

      const result = await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "trace",
          "import-otlp",
          "--input",
          input,
          "--source-ref",
          "fixtures/otlp-cli.json",
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("OTLP diagnostic import written");
      const report = await readJson<OtlpDiagnosticImport>(
        path.join(out, "otlp-diagnostic-import.json")
      );
      const manifest = await readJson<Record<string, unknown>>(
        path.join(out, "trace-import-manifest.json")
      );
      const events = await readJson<Array<Record<string, unknown>>>(
        path.join(out, "diagnostic-events.json")
      );

      expect(report).toMatchObject({
        artifactType: "otlp_diagnostic_import",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE"
      });
      expect(report.events.length).toBeGreaterThan(0);
      expect(report.manifest).toEqual(manifest);
      expect(events).toEqual(report.events);
      expect(report.manifest).toMatchObject({
        artifactType: "trace_import_manifest",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("trace curate-production writes a draft curation report and Markdown with no gate authority", async () => {
    const dir = await tmp("awb-curation-cli-");
    try {
      const input = path.join(dir, "curation-input.json");
      const out = path.join(dir, "out");
      await writeJson(input, curationInput());

      const result = await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "trace",
          "curate-production",
          "--input",
          input,
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("production trace curation DRAFT");
      const report = await readJson<Record<string, unknown>>(
        path.join(out, "production-trace-curation.json")
      );
      const markdown = await readFile(
        path.join(out, "production-trace-curation.md"),
        "utf8"
      );

      expect(report).toMatchObject({
        artifactType: "production_trace_curation",
        packageState: "DRAFT",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE"
      });
      expect(report.reasonCodes).toEqual([
        "DRAFT_ONLY_NO_GATE_AUTHORITY",
        "PRODUCTION_TRACE_REVIEW_REQUIRED"
      ]);
      expect(markdown).toContain("Status: DIAGNOSTIC_ONLY");
      expect(markdown).toContain("Gate authority: NONE");
      expect(markdown).toContain("cannot activate cases");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("governance benchmark writes policy-complete diagnostic evidence and exits 2", async () => {
    const dir = await tmp("awb-governance-cli-");
    try {
      const input = path.join(dir, "governance-input.json");
      const out = path.join(dir, "out");
      await writeJson(input, governanceInput());

      const result = await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "governance",
          "benchmark",
          "--input",
          input,
          "--out",
          out
        ],
        { cwd, reject: false }
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("benchmark governance POLICY_COMPLETE");
      const report = await readJson<Record<string, unknown>>(
        path.join(out, "benchmark-governance-report.json")
      );
      const markdown = await readFile(
        path.join(out, "benchmark-governance-report.md"),
        "utf8"
      );

      expect(report).toMatchObject({
        artifactType: "benchmark_governance_report",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE",
        governanceStatus: "POLICY_COMPLETE",
        policyReviewDisposition: "REVIEW_READY"
      });
      expect(markdown).toContain("Status: DIAGNOSTIC_ONLY");
      expect(markdown).toContain("Gate authority: NONE");
      expect(markdown).toContain("does not publish a benchmark");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function curationInput(): ProductionTraceCurationInput {
  const sourceImport = importOtlpDiagnosticTrace({
    sourceRef: "fixtures/otlp-cli.json",
    otlp: otlpFixture()
  });
  const failure = sourceImport.events.find(
    (event) => event.eventType === "error"
  );
  const knownGood = sourceImport.events.find(
    (event) => event.eventType === "evaluation"
  );
  if (!failure || !knownGood) {
    throw new Error("OTLP curation fixture must contain failure and known-good events.");
  }

  return {
    sourceImport,
    sourceImportRef: "trace-import.json",
    sourceImportHash: sha256Text(stableJson(sourceImport)),
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
        sourceEventRefs: [`trace-import.json#event=${failure.eventId}`],
        knownGoodEventRefs: [`trace-import.json#event=${knownGood.eventId}`],
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
    generatedAt: "2026-07-26T00:00:00.000Z"
  };
}

function governanceInput(): BenchmarkGovernanceInput {
  return {
    benchmarkId: "awb-public-benchmark",
    benchmarkVersion: "1.0.0",
    generatedAt: "2026-07-27T00:00:00.000Z",
    identities: {
      taskHash: HASH_A,
      environmentHash: HASH_A,
      runnerHash: HASH_A,
      policyHash: HASH_A,
      harnessHash: HASH_A
    },
    splits: [
      { id: "development", taskSetHash: HASH_A, access: "public" },
      { id: "calibration", taskSetHash: HASH_B, access: "public" },
      { id: "holdout", taskSetHash: HASH_C, access: "restricted" },
      {
        id: "private_challenge",
        taskSetHash: HASH_D,
        access: "restricted"
      }
    ],
    splitIsolation: {
      policyVersion: "1.0.0",
      evidenceRef: "governance/split-isolation-review.json",
      evidenceHash: HASH_B,
      overlapCount: 0,
      holdoutLabelsExcludedFromFit: true,
      privateChallengeHidden: true
    },
    contamination: {
      policyVersion: "1.0.0",
      evidenceRef: "governance/contamination-review.json",
      evidenceHash: HASH_A,
      suspectedAction: "quarantine",
      confirmedAction: "retire"
    },
    saturation: {
      policyVersion: "1.0.0",
      metric: "pass_rate",
      threshold: 0.9,
      minimumSamples: 30,
      action: "refresh_private_challenge"
    },
    reproducibility: {
      runManifestRequired: true,
      artifactEvidenceRequired: true,
      immutableEnvironmentRequired: true
    },
    leaderboard: {
      forceRanking: false,
      incomparableDisplay: "INCOMPARABLE"
    },
    domainAdapters: [
      activeDomain("browser", "browser-reference"),
      activeDomain("research", "research-reference"),
      activeDomain("multimodal", "multimodal-reference"),
      activeDomain("customer_support", "support-reference")
    ]
  };
}

function activeDomain(
  domain: BenchmarkGovernanceInput["domainAdapters"][number]["domain"],
  adapterId: string
): BenchmarkGovernanceInput["domainAdapters"][number] {
  return {
    domain,
    adapterId,
    adapterVersion: "1.0.0",
    status: "active",
    observabilityBoundary: {
      ref: `domains/${domain}/observer-boundary.json`,
      hash: HASH_A
    },
    targetPack: {
      ref: `domains/${domain}/target-pack.yaml`,
      hash: HASH_B
    },
    conformance: {
      ref: `domains/${domain}/adapter-conformance-report.json`,
      hash: HASH_C
    }
  };
}

function otlpFixture() {
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            scope: { name: "p1-p2-cli-fixture" },
            spans: [
              span("abcdef0123456789", "checkout failure", {
                "agent.case_id": "case-payment",
                "error.type": "Timeout"
              }),
              span("fedcba9876543210", "checkout known good", {
                "agent.case_id": "case-payment",
                "evaluation.decision": "PASS"
              })
            ]
          }
        ]
      }
    ]
  };
}

function span(
  spanId: string,
  name: string,
  attributes: Record<string, string>
) {
  return {
    traceId: "0".repeat(32),
    spanId,
    name,
    attributes: Object.entries(attributes).map(([key, value]) => ({
      key,
      value: { stringValue: value }
    }))
  };
}
