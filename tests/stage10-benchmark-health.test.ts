import { describe, expect, test } from "vitest";
import {
  assertBenchmarkHealthReportIntegrity,
  benchmarkHealthExitCode,
  buildBenchmarkHealthReport,
  type BenchmarkHealthInput
} from "../src/ci/benchmarkHealth.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

describe("Stage 10 benchmark health", () => {
  test("makes a fully evidenced healthy version release-eligible without side effects", () => {
    const report = buildBenchmarkHealthReport(healthyInput());

    expect(report.status).toBe("HEALTHY");
    expect(report.versionDisposition).toBe("RELEASE_ELIGIBLE");
    expect(report.reasonCodes).toEqual([]);
    expect(report.automaticActions).toEqual({
      versionDispositionApplied: true,
      trustEnrollment: "disabled",
      workflowModification: "disabled",
      fixPullRequestCreation: "disabled"
    });
    expect(report.integrity.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(benchmarkHealthExitCode(report)).toBe(0);
    expect(() =>
      assertBenchmarkHealthReportIntegrity(report)
    ).not.toThrow();
    const tampered = structuredClone(report);
    tampered.versionDisposition = "DIAGNOSTIC_ONLY";
    expect(() =>
      assertBenchmarkHealthReportIntegrity(tampered)
    ).toThrow(/integrity/u);
  });

  test.each([
    {
      name: "P0 false negative",
      mutate: (input: BenchmarkHealthInput) => {
        input.p0Mutation.falseNegativeCount = 1;
      },
      code: "HEALTH_P0_FALSE_NEGATIVE"
    },
    {
      name: "false PASS",
      mutate: (input: BenchmarkHealthInput) => {
        input.goldCorpus.falsePassCount = 1;
      },
      code: "HEALTH_FALSE_PASS"
    },
    {
      name: "Observer qualification invalid",
      mutate: (input: BenchmarkHealthInput) => {
        input.observerQualification.decision = "invalid";
        input.observerQualification.status = "FAIL";
      },
      code: "HEALTH_OBSERVER_UNQUALIFIED"
    },
    {
      name: "schema incompatible",
      mutate: (input: BenchmarkHealthInput) => {
        input.schemaCompatibility.compatible = false;
        input.schemaCompatibility.incompatibleArtifactCount = 1;
        input.schemaCompatibility.status = "FAIL";
      },
      code: "HEALTH_SCHEMA_INCOMPATIBLE"
    },
    {
      name: "A/A reliability BLOCK",
      mutate: (input: BenchmarkHealthInput) => {
        input.aaReliability.gateEligibility = "BLOCK";
        input.aaReliability.status = "FAIL";
      },
      code: "HEALTH_RELIABILITY_FAILED"
    }
  ])("automatically downgrades on $name", ({ mutate, code }) => {
    const input = healthyInput();
    mutate(input);
    const report = buildBenchmarkHealthReport(input);

    expect(report.status).toBe("DEGRADED");
    expect(report.versionDisposition).toBe("DIAGNOSTIC_ONLY");
    expect(report.reasonCodes).toContain(code);
    expect(report.automaticActions.versionDispositionApplied).toBe(true);
    expect(benchmarkHealthExitCode(report)).toBe(2);
  });

  test("fails closed on plugin or privacy health and rejects non-portable evidence refs", () => {
    const input = healthyInput();
    input.pluginInstall.status = "FAIL";
    input.pluginInstall.freshInstall = false;
    input.privacyScan.status = "FAIL";
    input.privacyScan.findingCount = 2;
    const report = buildBenchmarkHealthReport(input);
    expect(report.versionDisposition).toBe("DIAGNOSTIC_ONLY");
    expect(report.reasonCodes).toEqual(
      expect.arrayContaining([
        "HEALTH_PLUGIN_INSTALL_FAILED",
        "HEALTH_PRIVACY_SCAN_FAILED"
      ])
    );

    const unsafe = healthyInput();
    unsafe.goldCorpus.evidenceRef = "/private/target/trace.json";
    expect(() => buildBenchmarkHealthReport(unsafe)).toThrow(
      /portable evidence ref/u
    );
  });
});

function healthyInput(): BenchmarkHealthInput {
  return {
    benchmarkVersion: "0.1.0",
    generatedAt: "2026-07-25T00:00:00.000Z",
    goldCorpus: {
      status: "PASS",
      evidenceRef: "health/gold-corpus-report.json",
      evidenceHash: HASH_A,
      p0MutationKillRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0,
      knownGoodBlockedCount: 0
    },
    p0Mutation: {
      status: "PASS",
      evidenceRef: "health/p0-mutation-report.json",
      evidenceHash: HASH_B,
      detectionRate: 1,
      falseNegativeCount: 0,
      falsePassCount: 0
    },
    observerQualification: {
      status: "PASS",
      evidenceRef: "health/observer-qualification.json",
      evidenceHash: HASH_C,
      decision: "valid",
      p0DetectionRate: 1,
      falsePassCount: 0,
      privateKeyVisibleToRunner: false
    },
    aaReliability: {
      status: "PASS",
      evidenceRef: "health/reliability-report.json",
      evidenceHash: HASH_A,
      gateEligibility: "ELIGIBLE",
      deterministicAgreement: 1,
      stableGateAgreement: 1,
      p0FalsePassCount: 0,
      sampleSufficient: true
    },
    schemaCompatibility: {
      status: "PASS",
      evidenceRef: "health/schema-compatibility.json",
      evidenceHash: HASH_B,
      compatible: true,
      incompatibleArtifactCount: 0
    },
    pluginInstall: {
      status: "PASS",
      evidenceRef: "health/plugin-install.json",
      evidenceHash: HASH_C,
      freshInstall: true,
      runtimeParity: true
    },
    privacyScan: {
      status: "PASS",
      evidenceRef: "health/privacy-scan.json",
      evidenceHash: HASH_A,
      findingCount: 0
    }
  };
}
