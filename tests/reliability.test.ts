import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  analyzeReliabilitySamples,
  type ReliabilityPolicy,
  type ReliabilitySample
} from "../src/reliability/reliability.js";
import { hashFile } from "../src/utils/hash.js";

const cwd = process.cwd();
const seed = "stage4-fixed-seed";
const policy: ReliabilityPolicy = {
  deterministicMinimumSamples: 5,
  liveMinimumSamples: 20,
  gateConsistencyMinimum: 0.95,
  caseConsistencyMinimum: 0.95,
  maximumMissingRate: 0,
  minimumTelemetryCompleteness: 0.75,
  confidenceLevel: 0.95,
  bootstrapIterations: 200,
  defaultSeed: seed
};

function sample(
  index: number,
  overrides: Partial<ReliabilitySample> = {}
): ReliabilitySample {
  return {
    status: "observed",
    sampleId: `sample-${String(index).padStart(2, "0")}`,
    evidenceHash: `sha256:${index.toString(16).padStart(64, "0")}`,
    attemptFingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
    baselineRunId: `baseline-${index}`,
    candidateRunId: `candidate-${index}`,
    context: {
      targetId: "fixture-target",
      suite: "smoke",
      contractHash: `sha256:${"a".repeat(64)}`,
      caseSetHash: `sha256:${"b".repeat(64)}`,
      conditionsHash: `sha256:${"c".repeat(64)}`,
      runnerFingerprint: `sha256:${"d".repeat(64)}`,
      environmentFingerprint: `sha256:${"e".repeat(64)}`,
      observerVersion: "not_applicable",
      model: "unspecified",
      permissionMode: "none",
      budgetHash: `sha256:${"f".repeat(64)}`,
      seed,
      executionMode: "simulated",
      evidenceKind: "simulated",
      observationLevel: "synthetic_events",
      observerQualificationStatus: "not_applicable"
    },
    outcome: {
      classification: "UNCHANGED",
      gateDecision: "DIAGNOSTIC_ONLY",
      baselineScore: 100,
      candidateScore: 100,
      scoreDelta: 0,
      telemetryCompleteness: 1,
      dimensions: [
        { dimension: "contract", baseline: 100, candidate: 100 }
      ],
      cases: [
        {
          caseId: "fixture-case",
          candidateVerdict: "PASS",
          candidateHardFailures: []
        }
      ]
    },
    ...overrides
  };
}

describe("reliability statistics", () => {
  test("reports deterministic fixture reproducibility without a strong trust conclusion", () => {
    const report = analyzeReliabilitySamples(
      {
        studyId: "deterministic-study",
        kind: "deterministic_repeat",
        seed
      },
      Array.from({ length: 5 }, (_, index) => sample(index + 1)),
      policy
    );

    expect(report.conclusion).toBe("DIAGNOSTIC_REPRODUCIBLE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.metrics.sampleSize).toEqual({
      requested: 5,
      observed: 5,
      missing: 0,
      minimum: 5
    });
    expect(report.metrics.deterministicAgreement).toBe(1);
    expect(report.metrics.gateConsistency.pointEstimate).toBe(1);
    expect(report.metrics.pairedDelta).toMatchObject({
      mean: 0,
      variance: 0,
      interval: {
        kind: "bootstrap",
        confidenceLevel: 0.95,
        lower: 0,
        upper: 0
      }
    });
    expect(report.metrics.p0FalsePassCount).toBe(0);
    expect(report.debugHealth).toEqual({
      status: "PASS",
      environmentReproducibility: 1,
      doesNotAffectTargetScore: true
    });
  });

  test("quarantines unstable live outcomes without deleting attempts", () => {
    const samples = Array.from({ length: 20 }, (_, index) => {
      const unstable = index >= 18;
      return sample(index + 1, {
        context: {
          ...sample(index + 1).context,
          observerVersion: "1.0.0",
          executionMode: "live",
          evidenceKind: "live",
          observationLevel: "workflow_trace",
          observerQualificationStatus: "valid"
        },
        outcome: {
          ...sample(index + 1).outcome,
          gateDecision: unstable ? "BLOCK" : "PASS",
          cases: [
            {
              caseId: "fixture-case",
              candidateVerdict: unstable ? "FAIL" : "PASS",
              candidateHardFailures: []
            }
          ]
        }
      });
    });
    const report = analyzeReliabilitySamples(
      { studyId: "unstable-live", kind: "live_aa", seed },
      samples,
      policy
    );

    expect(report.metrics.sampleSize.requested).toBe(20);
    expect(report.samples).toHaveLength(20);
    expect(report.metrics.gateConsistency.pointEstimate).toBe(0.9);
    expect(report.quarantinedCases).toEqual([
      expect.objectContaining({
        caseId: "fixture-case",
        consistency: 0.9,
        status: "QUARANTINED"
      })
    ]);
    expect(report.conclusion).toBe("QUARANTINED");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("allows a strong live reliability conclusion at the frozen threshold", () => {
    const samples = Array.from({ length: 20 }, (_, index) =>
      sample(index + 1, {
        context: {
          ...sample(index + 1).context,
          observerVersion: "1.0.0",
          executionMode: "live",
          evidenceKind: "live",
          observationLevel: "workflow_trace",
          observerQualificationStatus: "valid"
        },
        outcome: {
          ...sample(index + 1).outcome,
          gateDecision: index === 19 ? "BLOCK" : "PASS"
        }
      })
    );
    const report = analyzeReliabilitySamples(
      { studyId: "stable-live", kind: "live_paired", seed },
      samples,
      policy
    );

    expect(report.metrics.gateConsistency.pointEstimate).toBe(0.95);
    expect(report.metrics.gateConsistency.interval).toMatchObject({
      kind: "wilson",
      confidenceLevel: 0.95
    });
    expect(report.quarantinedCases).toEqual([]);
    expect(report.conclusion).toBe("RELIABLE");
    expect(report.strongConclusionAllowed).toBe(true);
    expect(report.gateEligibility).toBe("ELIGIBLE");
  });

  test("refuses strong conclusions when the live sample is undersized", () => {
    const samples = Array.from({ length: 5 }, (_, index) =>
      sample(index + 1, {
        context: {
          ...sample(index + 1).context,
          observerVersion: "1.0.0",
          executionMode: "live",
          evidenceKind: "live",
          observationLevel: "workflow_trace",
          observerQualificationStatus: "valid"
        },
        outcome: {
          ...sample(index + 1).outcome,
          gateDecision: "PASS"
        }
      })
    );
    const report = analyzeReliabilitySamples(
      { studyId: "undersized-live", kind: "live_aa", seed },
      samples,
      policy
    );

    expect(report.metrics.sampleSize.minimum).toBe(20);
    expect(report.conclusion).toBe("INSUFFICIENT_SAMPLE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
  });

  test("blocks a reliability claim when any P0 failure receives PASS", () => {
    const falsePass = sample(1, {
      context: {
        ...sample(1).context,
        observerVersion: "1.0.0",
        executionMode: "live",
        evidenceKind: "live",
        observationLevel: "workflow_trace",
        observerQualificationStatus: "valid"
      },
      outcome: {
        ...sample(1).outcome,
        gateDecision: "PASS",
        cases: [
          {
            caseId: "p0-case",
            candidateVerdict: "FAIL",
            candidateHardFailures: [
              { code: "TARGET_ROUTE_FORBIDDEN", severity: "P0" }
            ]
          }
        ]
      }
    });
    const report = analyzeReliabilitySamples(
      { studyId: "false-pass-live", kind: "live_paired", seed },
      [falsePass, ...Array.from({ length: 19 }, (_, index) => sample(index + 2))],
      policy
    );

    expect(report.metrics.p0FalsePassCount).toBe(1);
    expect(report.conclusion).toBe("INVALID");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("BLOCK");
  });
});

describe("reliability CLI", () => {
  let root = "";
  let studyPath = "";
  let baselineDir = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-reliability-"));
    baselineDir = path.join(root, "baseline");
    await runDeterministicFixture(baselineDir);
    const pairs = [];
    for (let index = 0; index < 5; index += 1) {
      const candidate = path.join(root, `candidate-${index + 1}`);
      await runDeterministicFixture(candidate);
      pairs.push({
        sampleId: `repeat-${index + 1}`,
        baseline: path.relative(root, baselineDir),
        candidate: path.relative(root, candidate)
      });
    }
    studyPath = path.join(root, "reliability-study.json");
    await writeFile(
      studyPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          studyId: "deterministic-cli-study",
          kind: "deterministic_repeat",
          seed,
          pairs
        },
        null,
        2
      )}\n`
    );
  }, 30_000);

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits a schema-valid, integrity-bound deterministic diagnostic report", async () => {
    const out = path.join(root, "report");
    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "debug",
        "reliability",
        "--study",
        studyPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    expect(execution.exitCode).toBe(2);
    const reportPath = path.join(out, "reliability-report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const schema = JSON.parse(
      await readFile(
        path.join(cwd, "schemas", "reliability-report.schema.json"),
        "utf8"
      )
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report).toMatchObject({
      resultType: "reliability_report",
      conclusion: "DIAGNOSTIC_REPRODUCIBLE",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY",
      metrics: {
        deterministicAgreement: 1,
        p0FalsePassCount: 0,
        sampleSize: {
          requested: 5,
          observed: 5,
          missing: 0,
          minimum: 5
        }
      },
      debugHealth: {
        environmentReproducibility: 1
      },
      integrity: {
        status: "VERIFIED_AT_WRITE",
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(await readFile(path.join(out, "reliability-report.md"), "utf8")).toContain(
      "Gate consistency"
    );
    expect(JSON.stringify(report)).not.toContain(root);

    for (let index = 0; index < 5; index += 1) {
      const provenance = JSON.parse(
        await readFile(
          path.join(root, `candidate-${index + 1}`, "provenance.json"),
          "utf8"
        )
      );
      expect(provenance.conditions.seed).toBe(seed);
    }
  }, 30_000);

  test("retains missing attempts and refuses a strong conclusion", async () => {
    const missingStudyPath = path.join(root, "missing-study.json");
    const pairs = Array.from({ length: 5 }, (_, index) => ({
      sampleId: `missing-repeat-${index + 1}`,
      baseline: path.relative(root, baselineDir),
      candidate:
        index === 4 ? "candidate-does-not-exist" : `candidate-${index + 1}`
    }));
    await writeFile(
      missingStudyPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          studyId: "missing-attempt-study",
          kind: "deterministic_repeat",
          seed,
          pairs
        },
        null,
        2
      )}\n`
    );
    const out = path.join(root, "missing-report");
    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "debug",
        "reliability",
        "--study",
        missingStudyPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    const report = JSON.parse(
      await readFile(path.join(out, "reliability-report.json"), "utf8")
    );

    expect(execution.exitCode).toBe(2);
    expect(report).toMatchObject({
      conclusion: "INSUFFICIENT_SAMPLE",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY",
      metrics: {
        sampleSize: {
          requested: 5,
          observed: 4,
          missing: 1,
          minimum: 5
        },
        missingRate: 0.2
      }
    });
    expect(report.samples).toHaveLength(5);
    expect(report.samples[4]).toMatchObject({
      status: "missing",
      sampleId: "missing-repeat-5",
      missingReason: "RUN_MISSING"
    });
    expect(JSON.stringify(report)).not.toContain(root);
  }, 30_000);

  test("rejects a symlinked run reference that escapes the study root", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "awb-reliability-outside-")
    );
    try {
      await symlink(outside, path.join(root, "escaped-run"));
      const escapedStudyPath = path.join(root, "escaped-study.json");
      await writeFile(
        escapedStudyPath,
        `${JSON.stringify(
          {
            schemaVersion: "0.1.0",
            studyId: "escaped-study",
            kind: "deterministic_repeat",
            seed,
            pairs: [
              {
                sampleId: "escaped-repeat",
                baseline: path.relative(root, baselineDir),
                candidate: "escaped-run"
              }
            ]
          },
          null,
          2
        )}\n`
      );
      const execution = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reliability",
          "--study",
          escapedStudyPath,
          "--out",
          path.join(root, "escaped-report")
        ],
        { cwd, reject: false }
      );

      expect(execution.exitCode).toBe(1);
      expect(execution.stderr).toContain(
        "Reliability study reference resolves outside the study root."
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects an evaluation directory whose nested run symlink escapes the study root", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "awb-reliability-nested-outside-")
    );
    try {
      const outsideRun = path.join(outside, "outside-run");
      await cp(path.join(root, "candidate-1"), outsideRun, {
        recursive: true
      });
      const evaluationDir = path.join(root, "nested-evaluation");
      await mkdir(evaluationDir);
      await symlink(outsideRun, path.join(evaluationDir, "run"));
      const nestedStudyPath = path.join(root, "nested-escaped-study.json");
      await writeFile(
        nestedStudyPath,
        `${JSON.stringify(
          {
            schemaVersion: "0.1.0",
            studyId: "nested-escaped-study",
            kind: "deterministic_repeat",
            seed,
            pairs: [
              {
                sampleId: "nested-escaped-repeat",
                baseline: path.relative(root, baselineDir),
                candidate: "nested-evaluation"
              }
            ]
          },
          null,
          2
        )}\n`
      );
      const execution = await execa(
        "npm",
        [
          "run",
          "benchmark",
          "--",
          "debug",
          "reliability",
          "--study",
          nestedStudyPath,
          "--out",
          path.join(root, "nested-escaped-report")
        ],
        { cwd, reject: false }
      );

      expect(execution.exitCode).toBe(1);
      expect(execution.stderr).toContain(
        "Reliability study run resolves outside the study root."
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("treats a rehashed malformed run id as invalid evidence", async () => {
    const tampered = path.join(root, "tampered-run-id");
    await cp(path.join(root, "candidate-5"), tampered, {
      recursive: true
    });
    const suitePath = path.join(tampered, "suite-result.json");
    const provenancePath = path.join(tampered, "provenance.json");
    const suite = JSON.parse(await readFile(suitePath, "utf8"));
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    suite.runId = "bad run id";
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
    provenance.integrity.artifacts.find(
      (artifact: { ref: string }) => artifact.ref === "suite-result.json"
    ).sha256 = await hashFile(suitePath);
    await writeFile(
      provenancePath,
      `${JSON.stringify(provenance, null, 2)}\n`
    );

    const malformedStudyPath = path.join(root, "malformed-run-id-study.json");
    await writeFile(
      malformedStudyPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          studyId: "malformed-run-id-study",
          kind: "deterministic_repeat",
          seed,
          pairs: [
            ...Array.from({ length: 4 }, (_, index) => ({
              sampleId: `valid-repeat-${index + 1}`,
              baseline: path.relative(root, baselineDir),
              candidate: `candidate-${index + 1}`
            })),
            {
              sampleId: "malformed-repeat",
              baseline: path.relative(root, baselineDir),
              candidate: path.relative(root, tampered)
            }
          ]
        },
        null,
        2
      )}\n`
    );
    const out = path.join(root, "malformed-run-id-report");
    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "debug",
        "reliability",
        "--study",
        malformedStudyPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    const report = JSON.parse(
      await readFile(path.join(out, "reliability-report.json"), "utf8")
    );

    expect(execution.exitCode).toBe(2);
    expect(report).toMatchObject({
      conclusion: "INSUFFICIENT_SAMPLE",
      strongConclusionAllowed: false,
      metrics: {
        sampleSize: {
          requested: 5,
          observed: 4,
          missing: 1
        }
      }
    });
    expect(report.samples[4]).toMatchObject({
      status: "missing",
      missingReason: "RUN_INVALID"
    });
  }, 30_000);

  test("cannot upgrade fully rewritten unsigned replay into a strong conclusion", async () => {
    const pairs = [];
    for (let index = 0; index < 5; index += 1) {
      const candidateName = `replayed-candidate-${index + 1}`;
      const candidate = path.join(root, candidateName);
      await cp(path.join(root, "candidate-1"), candidate, {
        recursive: true
      });
      const suitePath = path.join(candidate, "suite-result.json");
      const runtimePath = path.join(candidate, "runtime-manifest.json");
      const provenancePath = path.join(candidate, "provenance.json");
      const suite = JSON.parse(await readFile(suitePath, "utf8"));
      const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
      const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
      suite.runId = candidateName;
      runtime.attemptId = `attempt-rewritten-${index + 1}`;
      provenance.subject.attemptId = runtime.attemptId;
      await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
      await writeFile(
        runtimePath,
        `${JSON.stringify(runtime, null, 2)}\n`
      );
      provenance.integrity.artifacts.find(
        (artifact: { ref: string }) => artifact.ref === "suite-result.json"
      ).sha256 = await hashFile(suitePath);
      provenance.integrity.artifacts.find(
        (artifact: { ref: string }) =>
          artifact.ref === "runtime-manifest.json"
      ).sha256 = await hashFile(runtimePath);
      await writeFile(
        provenancePath,
        `${JSON.stringify(provenance, null, 2)}\n`
      );
      pairs.push({
        sampleId: `replayed-repeat-${index + 1}`,
        baseline: path.relative(root, baselineDir),
        candidate: candidateName
      });
    }
    const replayStudyPath = path.join(root, "replayed-study.json");
    await writeFile(
      replayStudyPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          studyId: "replayed-attempt-study",
          kind: "deterministic_repeat",
          seed,
          pairs
        },
        null,
        2
      )}\n`
    );
    const out = path.join(root, "replayed-report");
    const execution = await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "debug",
        "reliability",
        "--study",
        replayStudyPath,
        "--out",
        out
      ],
      { cwd, reject: false }
    );
    const report = JSON.parse(
      await readFile(path.join(out, "reliability-report.json"), "utf8")
    );

    expect(execution.exitCode).toBe(2);
    expect(report).toMatchObject({
      conclusion: "DIAGNOSTIC_REPRODUCIBLE",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY"
    });
  }, 30_000);

  async function runDeterministicFixture(out: string): Promise<void> {
    await execa(
      "npm",
      [
        "run",
        "benchmark",
        "--",
        "run",
        "--target",
        "minimal-directory-agent",
        "--suite",
        "smoke",
        "--runner",
        "simulated",
        "--seed",
        seed,
        "--out",
        out
      ],
      { cwd }
    );
  }
});
