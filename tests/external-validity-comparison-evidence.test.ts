import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadTargetPack } from "../src/core/targetRegistry.js";
import type { BenchmarkCase, RunEvent } from "../src/core/types.js";
import { materializeSmokeSuite } from "../src/generator/materialize.js";
import {
  loadCanonicalGatePolicy,
  reviseGatePolicy,
  type GatePolicy
} from "../src/calibration/gatePolicy.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  referenceObserverImplementationHash
} from "../src/observer/referenceObserver.js";
import { profileTarget } from "../src/profiler/profileTarget.js";
import { verifyExternalValidityComparisonEvidence } from "../src/validity/comparisonEvidence.js";
import {
  analyzeExternalValidityFromComparisons,
  type ExternalValidityObservationSet,
  type ExternalValidityStudy
} from "../src/validity/externalValidity.js";
import { semanticCaseSetHash } from "../src/regression/provenance.js";
import { hashFile, sha256Text, stableJson } from "../src/utils/hash.js";

const cwd = process.cwd();
let root = "";
let observerPublicKeyPath = "";
let qualificationPublicKeyPath = "";
let observerPrivateKeyPath = "";
let qualificationPrivateKeyPath = "";
let qualifiedComparisonPath = "";
let customPolicyQualifiedComparisonPath = "";
let unqualifiedComparisonPath = "";
let customPolicy: GatePolicy;
let customPolicyPath = "";

describe("external validity comparison evidence verification", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "awb-external-validity-comparison-"));
    const observerKeys = generateKeyPairSync("ed25519");
    const qualificationKeys = generateKeyPairSync("ed25519");
    observerPublicKeyPath = path.join(root, "observer-public.pem");
    qualificationPublicKeyPath = path.join(root, "qualification-public.pem");
    observerPrivateKeyPath = path.join(root, "observer-private.pem");
    qualificationPrivateKeyPath = path.join(root, "qualification-private.pem");
    await writeFile(observerPublicKeyPath, observerKeys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(qualificationPublicKeyPath, qualificationKeys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(observerPrivateKeyPath, observerKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(qualificationPrivateKeyPath, qualificationKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

    const profile = await profileTarget(await loadTargetPack("minimal-directory-agent"));
    const suite = materializeSmokeSuite(profile.contract, { seed: "external-validity-comparison" });
    const baselineTracePath = path.join(root, "baseline-workflow-trace.json");
    const candidateTracePath = path.join(root, "candidate-workflow-trace.json");
    await writeSignedTrace(
      baselineTracePath,
      makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "baseline"),
      observerKeys.privateKey,
      observerKeys.publicKey
    );
    await writeSignedTrace(
      candidateTracePath,
      makeTracePayload(profile.contract.targetId, profile.contract.contractHash, suite.cases, "candidate"),
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
    const qualificationArtifactPath = path.join(qualificationDir, "observer-qualification.json");
    customPolicy = reviseGatePolicy(loadCanonicalGatePolicy(), {
      policyVersion: "1.0.1",
      rules: loadCanonicalGatePolicy().rules
    });
    customPolicyPath = path.join(root, "gate-policy-1.0.1.json");
    await writeFile(customPolicyPath, `${JSON.stringify(customPolicy, null, 2)}\n`);

    const baselineQualified = path.join(root, "baseline-qualified");
    const candidateQualified = path.join(root, "candidate-qualified");
    await ingestTrace(baselineTracePath, baselineQualified, qualificationArtifactPath);
    await ingestTrace(candidateTracePath, candidateQualified, qualificationArtifactPath);
    const qualifiedComparisonDir = path.join(root, "comparison-qualified");
    await compareRuns(baselineQualified, candidateQualified, qualifiedComparisonDir, true);
    qualifiedComparisonPath = path.join(qualifiedComparisonDir, "comparison-result.json");

    await bindRunToGatePolicy(baselineQualified, customPolicy);
    await bindRunToGatePolicy(candidateQualified, customPolicy);
    const customPolicyComparisonDir = path.join(root, "comparison-qualified-custom-policy");
    await compareRuns(
      baselineQualified,
      candidateQualified,
      customPolicyComparisonDir,
      true,
      customPolicyPath
    );
    customPolicyQualifiedComparisonPath = path.join(
      customPolicyComparisonDir,
      "comparison-result.json"
    );

    const baselineUnqualified = path.join(root, "baseline-unqualified");
    const candidateUnqualified = path.join(root, "candidate-unqualified");
    await ingestTrace(baselineTracePath, baselineUnqualified);
    await ingestTrace(candidateTracePath, candidateUnqualified);
    const unqualifiedComparisonDir = path.join(root, "comparison-unqualified");
    await compareRuns(baselineUnqualified, candidateUnqualified, unqualifiedComparisonDir, false);
    unqualifiedComparisonPath = path.join(unqualifiedComparisonDir, "comparison-result.json");
  }, 60_000);

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extracts public-safe evidence from a verified qualified live workflow-trace comparison", async () => {
    const result = await verifyExternalValidityComparisonEvidence(qualifiedComparisonPath, {
      trustedObserverKeyPath: observerPublicKeyPath,
      trustedQualificationKeyPath: qualificationPublicKeyPath
    });

    expect(result).toMatchObject({
      status: "VALID",
      evidence: {
        classification: "UNCHANGED",
        gateDecision: "PASS",
        failureCodes: [],
        runner: "codex",
        contractHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        comparisonHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        targetIdHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        baselineContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        candidateContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        attemptFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(JSON.stringify(result)).not.toContain("minimal-directory-agent");
    expect(JSON.stringify(result)).not.toContain(root);

    if (result.status !== "VALID") {
      throw new Error("Qualified comparison fixture did not verify.");
    }
    const study: ExternalValidityStudy = {
      schemaVersion: "0.1.0",
      resultType: "external_validity_study",
      studyId: "qualified-comparison-integration",
      protocolVersion: "criterion-validity-v1",
      blinding: {
        mode: "double_blind",
        assignmentHash: sha256Text("assignment")
      },
      targets: [
        {
          targetId: "external-target-directory",
          blindedTargetId: "target-1",
          targetClass: "directory",
          targetRefHash: result.evidence.targetIdHash,
          contractHash: result.evidence.contractHash,
          contractReview: {
            status: "reviewed",
            artifactHash: sha256Text("owner-review")
          }
        }
      ],
      items: [
        {
          itemId: "qualified-item-1",
          blindedChangeId: "change-1",
          targetId: "external-target-directory",
          runner: result.evidence.runner,
          runnerBlindId: "runner-a",
          designStratum: "no_change",
          baseline: {
            ref: "external://qualified-baseline",
            contentHash: result.evidence.baselineContentHash
          },
          candidate: {
            ref: "external://qualified-candidate",
            contentHash: result.evidence.candidateContentHash
          }
        }
      ]
    };
    const observations: ExternalValidityObservationSet = {
      schemaVersion: "0.1.0",
      resultType: "external_validity_observations",
      studyId: study.studyId,
      status: "COMPLETE",
      items: [
        {
          itemId: "qualified-item-1",
          evidence: {
            comparisonRef: qualifiedComparisonPath,
            comparisonHash: result.evidence.comparisonHash
          }
        }
      ]
    };
    const report = await analyzeExternalValidityFromComparisons(
      study,
      observations,
      undefined,
      {
        trustedObserverKeyPath: observerPublicKeyPath,
        trustedQualificationKeyPath: qualificationPublicKeyPath
      }
    );
    expect(report.metrics.sampleSize.observed).toBe(1);
    expect(report.blockers).not.toContain("UNQUALIFIED_EVIDENCE");
    expect(report.blockers).not.toContain("AWB_OBSERVATIONS_INCOMPLETE");
    expect(report.status).toBe("PENDING_HUMAN_INPUT");
  });

  test("rejects hand-authored comparison JSON even when it self-asserts valid live evidence", async () => {
    const forgedPath = path.join(root, "forged-comparison.json");
    await writeFile(
      forgedPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          product: "Agent Workflow Bench",
          baseline: {
            targetId: "minimal-directory-agent",
            suite: "smoke",
            runId: "baseline",
            releaseDecision: "APPROVE",
            score: 1,
            provenanceStatus: "VALID",
            evidenceKind: "live",
            observationLevel: "workflow_trace",
            observerQualificationStatus: "valid"
          },
          candidate: {
            targetId: "minimal-directory-agent",
            suite: "smoke",
            runId: "candidate",
            releaseDecision: "APPROVE",
            score: 1,
            provenanceStatus: "VALID",
            evidenceKind: "live",
            observationLevel: "workflow_trace",
            observerQualificationStatus: "valid"
          },
          comparability: { status: "COMPARABLE", reasons: [] },
          classification: "UNCHANGED",
          scoreDelta: 0,
          caseDeltas: [],
          summary: { improved: 0, regressed: 0, unchanged: 1, hardFailure: 0, incomparable: 0 },
          hardFailures: [],
          evidenceRefs: {
            baseline: ["baseline:workflow-trace.json"],
            candidate: ["candidate:workflow-trace.json"]
          },
          integrity: {
            status: "VERIFIED_AT_WRITE",
            comparisonHash: sha256Text("self-attested"),
            baselineRef: "evidence/baseline",
            candidateRef: "evidence/candidate",
            artifacts: []
          }
        },
        null,
        2
      )}\n`
    );

    await expect(
      verifyExternalValidityComparisonEvidence(forgedPath, {
        trustedObserverKeyPath: observerPublicKeyPath,
        trustedQualificationKeyPath: qualificationPublicKeyPath
      })
    ).resolves.toMatchObject({
      status: "INVALID",
      reason: "Comparison bundle could not be verified against its bundled evidence."
    });
  });

  test("uses the verified comparison gate policy when extracting gate evidence", async () => {
    await expect(
      verifyExternalValidityComparisonEvidence(customPolicyQualifiedComparisonPath, {
        trustedObserverKeyPath: observerPublicKeyPath,
        trustedQualificationKeyPath: qualificationPublicKeyPath,
        gatePolicy: customPolicy
      })
    ).resolves.toMatchObject({
      status: "VALID",
      evidence: {
        classification: "UNCHANGED",
        gateDecision: "PASS"
      }
    });
  });

  test("rejects otherwise verified workflow-trace comparisons without qualified observer evidence", async () => {
    await expect(
      verifyExternalValidityComparisonEvidence(unqualifiedComparisonPath, {
        trustedObserverKeyPath: observerPublicKeyPath,
        trustedQualificationKeyPath: qualificationPublicKeyPath
      })
    ).resolves.toMatchObject({
      status: "INVALID",
      reason: "Comparison does not contain qualified live workflow-trace evidence for both sides."
    });
  });

  test("requires both trusted public key paths before reading status claims", async () => {
    await expect(
      verifyExternalValidityComparisonEvidence(qualifiedComparisonPath, {
        trustedObserverKeyPath: observerPublicKeyPath
      })
    ).resolves.toMatchObject({
      status: "INVALID",
      reason: "External validity comparison evidence requires both trusted public key paths."
    });
  });
});

async function ingestTrace(
  tracePath: string,
  out: string,
  qualificationArtifactPath?: string
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
      ...(qualificationArtifactPath
        ? [
            "--observer-qualification",
            qualificationArtifactPath,
            "--trusted-qualification-key",
            qualificationPublicKeyPath
          ]
        : []),
      "--out",
      out
    ],
    { cwd }
  );
}

async function compareRuns(
  baseline: string,
  candidate: string,
  out: string,
  qualified: boolean,
  gatePolicyPath?: string
): Promise<void> {
  await execa(
    "node",
    [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--trusted-observer-key",
      observerPublicKeyPath,
      ...(qualified ? ["--trusted-qualification-key", qualificationPublicKeyPath] : []),
      ...(gatePolicyPath ? ["--gate-policy", gatePolicyPath] : []),
      "--out",
      out
    ],
    { cwd }
  );
}

function makeTracePayload(
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
      seed: "external-validity-comparison",
      caseSetHash: semanticCaseSetHash(cases),
      runner,
      isolation: "read_only_sandbox" as const,
      permissionMode: "read_only_no_approval" as const,
      model: "fixture-model"
    },
    cases: cases.map((testCase, index) => makeObservedCase(testCase, runLabel, index)),
    attestation: {
      algorithm: "ed25519" as const,
      signature: ""
    }
  };
}

function makeObservedCase(testCase: BenchmarkCase, runLabel: string, index: number) {
  const events: RunEvent[] = [];
  let sequence = 0;
  const push = (type: RunEvent["type"], actor: string, payload: Record<string, unknown>) => {
    sequence += 1;
    events.push({
      eventId: `${runLabel}-${index}-${sequence}`,
      timestamp: new Date(1_000 + sequence * 1_000).toISOString(),
      type,
      actor,
      payload
    });
  };
  push("case_start", "observer", { caseId: testCase.id, templateId: testCase.templateId });
  push("contract_observed", "observer", { contractHash: testCase.contractHash });
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
  push("runner_start", "observer", { runner: "codex", executionMode: "live" });
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
  push("handoff", testCase.bindings.primaryRole, { to: testCase.bindings.owner, status: "accepted" });
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
  push("runner_result", "observer", { verdict: "PASS", hardFailureCodes: [] });
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

async function writeSignedTrace(
  filePath: string,
  input: ReturnType<typeof makeTracePayload>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]
): Promise<void> {
  const payload = {
    ...input,
    observer: {
      ...input.observer,
      keyFingerprint: publicKeyFingerprint(publicKey.export({ type: "spki", format: "der" }))
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

async function bindRunToGatePolicy(
  runDir: string,
  policy: GatePolicy
): Promise<void> {
  const suitePath = path.join(runDir, "suite-result.json");
  const provenancePath = path.join(runDir, "provenance.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  suite.gatePolicy = {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    rulesHash: policy.rulesHash,
    policyHash: policy.policyHash
  };
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  provenance.integrity.artifacts.find(
    (artifact: { ref: string }) => artifact.ref === "suite-result.json"
  ).sha256 = await hashFile(suitePath);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}
