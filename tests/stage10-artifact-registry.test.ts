import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadArtifactCompatibilityMatrix,
  loadArtifactSchemaRegistry
} from "../src/artifacts/registry.js";
import { migrateArtifact } from "../src/artifacts/migration.js";
import {
  loadAdapterContract
} from "../src/adapters/sdk.js";
import {
  runAdapterDeclarationConformance
} from "../src/adapters/conformance.js";
import {
  buildBenchmarkHealthReport,
  type BenchmarkHealthInput
} from "../src/ci/benchmarkHealth.js";
import {
  buildRunnerRankingReport,
  type RunnerRankingInput
} from "../src/report/runnerRanking.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
let root = "";

describe("Stage 10 artifact registry and migration", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-stage10-registry-"));
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers Stage 10 artifacts and input/config schemas", async () => {
    const registry = await loadArtifactSchemaRegistry();
    const matrix = await loadArtifactCompatibilityMatrix();
    const artifactTypes = [
      "adapter_conformance_report",
      "benchmark_health_report",
      "runner_ranking_report"
    ];
    expect(registry.entries.map((entry) => entry.artifactType)).toEqual(
      expect.arrayContaining(artifactTypes)
    );
    expect(matrix.policies.map((policy) => policy.artifactType)).toEqual(
      expect.arrayContaining(artifactTypes)
    );
    expect(registry.schemaFiles).toEqual(
      expect.arrayContaining([
        "adapter-contract.schema.json",
        "adapter-conformance-report.schema.json",
        "benchmark-health-input.schema.json",
        "benchmark-health-report.schema.json",
        "runner-ranking-input.schema.json",
        "runner-ranking-report.schema.json"
      ])
    );
  });

  test("reads integrity-complete Stage 10 artifacts as current", async () => {
    const adapter = runAdapterDeclarationConformance(
      await loadAdapterContract(
        path.join(process.cwd(), "configs/adapters/reference-observer.json")
      ),
      { generatedAt: "2026-07-25T00:00:00.000Z" }
    );
    const health = buildBenchmarkHealthReport(healthyInput());
    const ranking = buildRunnerRankingReport(rankingInput());
    const artifacts = [
      ["adapter-conformance-report.json", adapter],
      ["benchmark-health-report.json", health],
      ["runner-ranking-report.json", ranking]
    ] as const;

    for (const [fileName, artifact] of artifacts) {
      const filePath = path.join(root, fileName);
      await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
      const migration = await migrateArtifact(filePath);
      expect(migration.result.status, fileName).toBe("CURRENT");
      expect(migration.result.trustDisposition, fileName).toBe(
        "PRESERVED"
      );
    }
  });

  test("downgrades a Stage 10 artifact with missing integrity binding", async () => {
    const report = buildBenchmarkHealthReport(healthyInput()) as unknown as {
      integrity?: unknown;
    };
    delete report.integrity;
    const filePath = path.join(root, "benchmark-health-report.json");
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
    const migration = await migrateArtifact(filePath);
    expect(migration.result.status).toBe("DIAGNOSTIC_ONLY");
    expect(migration.result.trustDisposition).toBe("DIAGNOSTIC_ONLY");
    expect(migration.result.reasonCodes).toContain(
      "ARTIFACT_TRUST_FIELDS_MISSING"
    );
  });
});

function healthyInput(): BenchmarkHealthInput {
  const evidence = (status: "PASS", evidenceRef: string, evidenceHash: string) => ({
    status,
    evidenceRef,
    evidenceHash
  });
  return {
    benchmarkVersion: "0.1.0",
    generatedAt: "2026-07-25T00:00:00.000Z",
    goldCorpus: {
      ...evidence("PASS", "health/gold.json", HASH_A),
      p0MutationKillRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0,
      knownGoodBlockedCount: 0
    },
    p0Mutation: {
      ...evidence("PASS", "health/p0.json", HASH_B),
      detectionRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0
    },
    observerQualification: {
      ...evidence("PASS", "health/observer.json", HASH_C),
      decision: "valid",
      p0DetectionRate: 1,
      falsePassCount: 0,
      privateKeyVisibleToRunner: false
    },
    aaReliability: {
      ...evidence("PASS", "health/reliability.json", HASH_A),
      gateEligibility: "DIAGNOSTIC_ONLY",
      deterministicAgreement: 1,
      stableGateAgreement: 1,
      p0FalsePassCount: 0,
      sampleSufficient: true
    },
    schemaCompatibility: {
      ...evidence("PASS", "health/schema.json", HASH_B),
      compatible: true,
      incompatibleArtifactCount: 0
    },
    pluginInstall: {
      ...evidence("PASS", "health/plugin.json", HASH_C),
      freshInstall: true,
      runtimeParity: true
    },
    privacyScan: {
      ...evidence("PASS", "health/privacy.json", HASH_A),
      findingCount: 0
    }
  };
}

function rankingInput(): RunnerRankingInput {
  const bindings = {
    taskId: "task-1",
    targetId: "minimal-directory-agent",
    contractHash: HASH_A,
    caseSetHash: HASH_B,
    observer: {
      id: "reference-observer",
      version: "1.0.0",
      keyFingerprint: HASH_A,
      qualificationArtifactHash: HASH_B,
      qualificationStatus: "valid" as const
    },
    budget: { wallClockSeconds: 300, tokenTotal: 10_000 },
    telemetry: {
      schemaVersion: "0.1.0",
      evidenceKind: "live" as const,
      observationLevel: "workflow_trace" as const,
      tokenSource: "native" as const,
      minimumCompleteness: 0.8
    }
  };
  return {
    rankingId: "registry-ranking",
    generatedAt: "2026-07-25T00:00:00.000Z",
    entries: [
      rankingEntry("codex", HASH_A, 90, structuredClone(bindings)),
      rankingEntry("opencode", HASH_C, 91, structuredClone(bindings))
    ]
  };
}

function rankingEntry(
  runnerName: "codex" | "opencode",
  capabilitiesHash: string,
  workflowScore: number,
  bindings: RunnerRankingInput["entries"][number]["bindings"]
): RunnerRankingInput["entries"][number] {
  return {
    runnerName,
    adapterVersion: "1.0.0",
    capabilitiesHash,
    comparability: {
      workflowScore: "comparable",
      efficiency: "comparable",
      tokenCost: "comparable"
    },
    bindings,
    metrics: {
      workflowScore,
      wallClockSeconds: 10,
      tokenTotal: 100,
      telemetryCompleteness: 0.9
    }
  };
}
