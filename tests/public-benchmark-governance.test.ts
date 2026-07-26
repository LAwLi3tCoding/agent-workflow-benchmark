import { describe, expect, test } from "vitest";
import {
  assertBenchmarkGovernanceReportIntegrity,
  buildBenchmarkGovernanceReport,
  compareGovernedRunIdentities,
  type BenchmarkGovernanceInput
} from "../src/governance/publicBenchmark.js";
import { createAjv2020 } from "../src/utils/jsonSchema.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

describe("public benchmark governance", () => {
  test("keeps domain adapters blocked until an explicit observability boundary is bound", () => {
    const report = buildBenchmarkGovernanceReport(governanceInput());

    expect(report.status).toBe("DIAGNOSTIC_ONLY");
    expect(report.gateAuthority).toBe("NONE");
    expect(report.governanceStatus).toBe("POLICY_COMPLETE");
    expect(report.policyReviewDisposition).toBe("REVIEW_READY");
    expect(report.domainReadiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "browser",
          disposition: "EVIDENCE_BOUND_DIAGNOSTIC"
        }),
        expect.objectContaining({
          domain: "research",
          disposition: "BLOCKED_OBSERVABILITY"
        }),
        expect.objectContaining({
          domain: "multimodal",
          disposition: "BLOCKED_OBSERVABILITY"
        }),
        expect.objectContaining({
          domain: "customer_support",
          disposition: "BLOCKED_OBSERVABILITY"
        })
      ])
    );
    assertBenchmarkGovernanceReportIntegrity(report);
  });

  test("rejects an active domain adapter without boundary, target-pack, and conformance bindings", () => {
    const input = governanceInput();
    input.domainAdapters[1] = {
      ...input.domainAdapters[1]!,
      status: "active"
    };

    expect(() => buildBenchmarkGovernanceReport(input)).toThrow(
      /active domain adapter.*bindings/i
    );
  });

  test("displays identity mismatches as incomparable instead of forcing a ranking", () => {
    const left = governanceInput().identities;

    expect(compareGovernedRunIdentities(left, left)).toEqual({
      status: "COMPARABLE",
      mismatchedAxes: []
    });
    expect(
      compareGovernedRunIdentities(left, {
        ...left,
        environmentHash: HASH_D,
        harnessHash: HASH_C
      })
    ).toEqual({
      status: "INCOMPARABLE",
      mismatchedAxes: ["environment", "harness"]
    });
  });

  test("fails governance when required split, contamination, saturation, or evidence policy is weakened", () => {
    const input = governanceInput();
    input.splits = input.splits.filter(
      (split) => split.id !== "private_challenge"
    );
    input.splitIsolation.holdoutLabelsExcludedFromFit = false;
    input.reproducibility.runManifestRequired = false;
    input.leaderboard.forceRanking = true;

    const report = buildBenchmarkGovernanceReport(input);

    expect(report.governanceStatus).toBe("BLOCKED");
    expect(report.policyReviewDisposition).toBe("BLOCKED");
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "GOVERNANCE_SPLIT_MISSING",
        "GOVERNANCE_SPLIT_ISOLATION_FAILED",
        "GOVERNANCE_REPRODUCIBILITY_INCOMPLETE",
        "GOVERNANCE_FORCED_RANKING_FORBIDDEN"
      ])
    );
  });

  test("blocks policy completeness when a governed domain is missing or holdout access is public", () => {
    const input = governanceInput();
    input.domainAdapters = input.domainAdapters.filter(
      (adapter) => adapter.domain !== "customer_support"
    );
    input.splits = input.splits.map((split) =>
      split.id === "holdout" ? { ...split, access: "public" } : split
    );

    const report = buildBenchmarkGovernanceReport(input);

    expect(report.governanceStatus).toBe("BLOCKED");
    expect(report.policyReviewDisposition).toBe("BLOCKED");
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "GOVERNANCE_DOMAIN_MISSING",
        "GOVERNANCE_HOLDOUT_EXPOSED"
      ])
    );
  });

  test("emits a schema-valid integrity-bound report", async () => {
    const report = buildBenchmarkGovernanceReport(governanceInput());
    const schema = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "schemas/benchmark-governance-report.schema.json"
        ),
        "utf8"
      )
    );
    const ajv = createAjv2020();
    const validate = ajv.compile(schema);

    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
  });
});

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
      {
        domain: "browser",
        adapterId: "browser-reference",
        adapterVersion: "1.0.0",
        status: "active",
        observabilityBoundary: {
          ref: "domains/browser/observer-boundary.json",
          hash: HASH_A
        },
        targetPack: {
          ref: "domains/browser/target-pack.yaml",
          hash: HASH_B
        },
        conformance: {
          ref: "domains/browser/adapter-conformance-report.json",
          hash: HASH_C
        }
      },
      {
        domain: "research",
        adapterId: "research-candidate",
        adapterVersion: "0.1.0",
        status: "candidate"
      },
      {
        domain: "multimodal",
        adapterId: "multimodal-candidate",
        adapterVersion: "0.1.0",
        status: "candidate"
      },
      {
        domain: "customer_support",
        adapterId: "support-candidate",
        adapterVersion: "0.1.0",
        status: "candidate"
      }
    ]
  };
}
