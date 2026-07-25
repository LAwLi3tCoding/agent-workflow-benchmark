import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
  gatePolicyBinding,
  loadCanonicalGatePolicy,
  reviseGatePolicy,
  type GatePolicy
} from "../src/calibration/gatePolicy.js";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import type { BenchmarkCase, RunEvent } from "../src/core/types.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  referenceObserverImplementationHash
} from "../src/observer/referenceObserver.js";
import {
  analyzeReliabilitySamples,
  type ReliabilityPolicy,
  type ReliabilitySample
} from "../src/reliability/reliability.js";
import { runReliabilityStudy } from "../src/reliability/study.js";
import { semanticCaseSetHash } from "../src/regression/provenance.js";
import { hashFile, stableJson } from "../src/utils/hash.js";

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

describe("reliability study gate policy propagation", () => {
  let root = "";
  let observerPublicKeyPath = "";
  let qualificationPublicKeyPath = "";
  let customPolicy: GatePolicy;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-reliability-policy-"));
    const observerKeys = generateKeyPairSync("ed25519");
    const qualificationKeys = generateKeyPairSync("ed25519");
    observerPublicKeyPath = path.join(root, "observer-public.pem");
    qualificationPublicKeyPath = path.join(root, "qualification-public.pem");
    const observerPrivateKeyPath = path.join(root, "observer-private.pem");
    const qualificationPrivateKeyPath = path.join(root, "qualification-private.pem");
    await writeFile(
      observerPublicKeyPath,
      observerKeys.publicKey.export({ type: "spki", format: "pem" })
    );
    await writeFile(
      qualificationPublicKeyPath,
      qualificationKeys.publicKey.export({ type: "spki", format: "pem" })
    );
    await writeFile(
      observerPrivateKeyPath,
      observerKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );
    await writeFile(
      qualificationPrivateKeyPath,
      qualificationKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 }
    );

    const profile = await profileMinimalTarget();
    const suite = materializeSmokeSuite(profile.contract, {
      seed: "reliability-custom-policy"
    });
    const baselineTracePath = path.join(root, "baseline-workflow-trace.json");
    const candidateTracePath = path.join(root, "candidate-workflow-trace.json");
    await writeSignedReliabilityTrace(
      baselineTracePath,
      makeReliabilityTracePayload(
        profile.contract.targetId,
        profile.contract.contractHash,
        suite.cases,
        "baseline"
      ),
      observerKeys.privateKey,
      observerKeys.publicKey
    );
    await writeSignedReliabilityTrace(
      candidateTracePath,
      makeReliabilityTracePayload(
        profile.contract.targetId,
        profile.contract.contractHash,
        suite.cases,
        "candidate"
      ),
      observerKeys.privateKey,
      observerKeys.publicKey
    );

    const qualificationDir = path.join(root, "qualification");
    await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "observer",
        "qualify",
        "--target",
        "minimal-directory-agent",
        "--suite",
        "smoke",
        "--observer-id",
        "fixture-observer",
        "--observer-version",
        "1.0.0",
        "--observer-private-key",
        observerPrivateKeyPath,
        "--qualification-authority-private-key",
        qualificationPrivateKeyPath,
        "--out",
        qualificationDir
      ],
      { cwd }
    );
    const qualificationArtifactPath = path.join(
      qualificationDir,
      "observer-qualification.json"
    );

    const baselineDir = path.join(root, "baseline");
    const candidateDir = path.join(root, "candidate");
    await ingestReliabilityTrace(
      baselineTracePath,
      baselineDir,
      observerPublicKeyPath,
      qualificationArtifactPath,
      qualificationPublicKeyPath
    );
    await ingestReliabilityTrace(
      candidateTracePath,
      candidateDir,
      observerPublicKeyPath,
      qualificationArtifactPath,
      qualificationPublicKeyPath
    );

    customPolicy = reviseGatePolicy(loadCanonicalGatePolicy(), {
      policyVersion: "1.0.1",
      rules: loadCanonicalGatePolicy().rules
    });
    await bindRunToGatePolicy(baselineDir, customPolicy);
    await bindRunToGatePolicy(candidateDir, customPolicy);

    await writeFile(
      path.join(root, "reliability-study.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          studyId: "custom-policy-live-study",
          kind: "live_aa",
          seed: "reliability-custom-policy",
          pairs: [
            {
              sampleId: "custom-policy-sample",
              baseline: "baseline",
              candidate: "candidate"
            }
          ]
        },
        null,
        2
      )}\n`
    );
  }, 60_000);

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evaluates reliability sample gates with the supplied historical policy", async () => {
    const report = await runReliabilityStudy(
      path.join(root, "reliability-study.json"),
      {
        trustedObserverKeyPath: observerPublicKeyPath,
        trustedQualificationKeyPath: qualificationPublicKeyPath,
        gatePolicy: customPolicy
      }
    );

    expect(report.samples[0]).toMatchObject({
      status: "observed",
      outcome: {
        classification: "UNCHANGED",
        gateDecision: "PASS"
      }
    });
  }, 30_000);
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

async function profileMinimalTarget() {
  const { profileTarget } = await import("../src/profiler/profileTarget.js");
  return profileTarget(await loadTargetPack("minimal-directory-agent"));
}

async function bindRunToGatePolicy(
  runDir: string,
  policy: GatePolicy
): Promise<void> {
  const suitePath = path.join(runDir, "suite-result.json");
  const provenancePath = path.join(runDir, "provenance.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  suite.gatePolicy = gatePolicyBinding(policy);
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "suite-result.json"
  ).sha256 = await hashFile(suitePath);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function ingestReliabilityTrace(
  tracePath: string,
  out: string,
  observerPublicKeyPath: string,
  qualificationArtifactPath: string,
  qualificationPublicKeyPath: string
): Promise<void> {
  await execa(
    "node",
    [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "ingest-trace",
      "--target",
      "minimal-directory-agent",
      "--suite",
      "smoke",
      "--trace",
      tracePath,
      "--trusted-observer-key",
      observerPublicKeyPath,
      "--observer-qualification",
      qualificationArtifactPath,
      "--trusted-qualification-key",
      qualificationPublicKeyPath,
      "--out",
      out
    ],
    { cwd }
  );
}

function makeReliabilityTracePayload(
  targetId: string,
  contractHash: string,
  cases: BenchmarkCase[],
  runLabel: string
) {
  const runner = {
    name: "codex" as const,
    adapterVersion: "observer-fixture-adapter-1",
    version: "fixture-codex",
    capabilitiesHash: `sha256:${"1".repeat(64)}`
  };
  return {
    schemaVersion: "0.1.0" as const,
    observer: {
      id: "fixture-observer",
      version: "1.0.0",
      keyFingerprint: "",
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES
    },
    subject: {
      targetId,
      contractHash,
      suite: "smoke",
      seed: "reliability-custom-policy",
      caseSetHash: semanticCaseSetHash(cases),
      runner,
      isolation: "read_only_sandbox" as const,
      permissionMode: "read_only_no_approval" as const,
      model: "fixture-model"
    },
    cases: cases.map((testCase, index) =>
      makeReliabilityObservedCase(testCase, runLabel, index)
    ),
    attestation: {
      algorithm: "ed25519" as const,
      signature: ""
    }
  };
}

function makeReliabilityObservedCase(
  testCase: BenchmarkCase,
  runLabel: string,
  index: number
) {
  const events: RunEvent[] = [];
  let sequence = 0;
  const push = (
    type: RunEvent["type"],
    actor: string,
    payload: Record<string, unknown>
  ) => {
    sequence += 1;
    events.push({
      eventId: `${runLabel}-${index}-${sequence}`,
      timestamp: new Date(1_000 + sequence * 1_000).toISOString(),
      type,
      actor,
      payload
    });
  };
  push("case_start", "observer", {
    caseId: testCase.id,
    templateId: testCase.templateId
  });
  push("contract_observed", "observer", {
    contractHash: testCase.contractHash
  });
  push("filesystem_access", "observer", {
    operation: "snapshot",
    root: "workspace://root",
    observedBy: "reference_observer"
  });
  push("network_access", "observer", {
    attempted: true,
    allowed: false,
    outcomeCode: "EPERM",
    policyDecision: "deny",
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("runner_start", "observer", {
    runner: "codex",
    executionMode: "live"
  });
  push("process_spawn", "observer", {
    executable: "fixture-codex",
    policyDecision: "allow",
    observedBy: "reference_observer"
  });
  push("tool_call", "observer", {
    tool: "observer-boundary-canary",
    attempted: true,
    allowed: false,
    outcomeCode: "EPERM",
    policyDecision: "deny",
    boundaryProbe: true,
    observedBy: "reference_observer"
  });
  push("handoff", testCase.bindings.primaryRole, {
    to: testCase.bindings.owner,
    status: "accepted"
  });
  push("artifact_write", "observer", {
    path: testCase.bindings.artifactPath,
    bytes: 128,
    observedBy: "reference_observer"
  });
  push("state_read", "observer", {
    path: "process/workflow-state.json",
    observedBy: "reference_observer"
  });
  push("gate_decision", testCase.bindings.owner, { status: "PASS" });
  push("side_effect_attempt", "observer", {
    attempted: false,
    policyDecision: "deny",
    allowed: false,
    classifiedAs: "none",
    observedBy: "reference_observer"
  });
  if (testCase.templateId === "side-effect-deny") {
    push("side_effect_attempt", "observer", {
      command: "fixture-production-write",
      policyDecision: "deny",
      allowed: false,
      classifiedAs: "production_write",
      observedBy: "reference_observer"
    });
  }
  push("runner_result", "observer", {
    verdict: "PASS",
    hardFailureCodes: []
  });
  push("runner_exit", "observer", { exitCode: 0, timedOut: false });
  push("token_usage", "observer", {
    input: 500,
    output: 100,
    total: 600,
    wasted: 20,
    source: "native",
    observedBy: "reference_observer"
  });
  push("case_end", "observer", { status: "completed" });
  return {
    caseId: testCase.id,
    templateId: testCase.templateId,
    runId: `observed-${runLabel}-${testCase.id}`,
    events,
    wallClockSeconds: 12,
    tokens: {
      input: 500,
      output: 100,
      total: 600,
      wasted: 20,
      costEstimateConfidence: "high" as const
    },
    telemetryCompleteness: 0.96
  };
}

async function writeSignedReliabilityTrace(
  filePath: string,
  input: ReturnType<typeof makeReliabilityTracePayload>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]
): Promise<void> {
  const payload = {
    ...input,
    observer: {
      ...input.observer,
      keyFingerprint: publicKeyFingerprint(
        publicKey.export({ type: "spki", format: "der" })
      )
    }
  };
  const { attestation: _attestation, ...unsigned } = payload;
  const signature = sign(null, Buffer.from(stableJson(unsigned)), privateKey).toString("base64");
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        ...unsigned,
        attestation: {
          algorithm: "ed25519",
          signature
        }
      },
      null,
      2
    )}\n`
  );
}

function publicKeyFingerprint(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}
