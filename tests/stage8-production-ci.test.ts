import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import {
  assessProductionReadiness,
  finalizeProductionBlockingAuthorization,
  prepareProductionBlockingAuthorization,
  PRODUCTION_CANARY_POLICY,
  PRODUCTION_CANARY_POLICY_HASH,
  validateProductionIsolationManifest
} from "../src/ci/productionGate.js";
import {
  buildProductionCanaryReport,
  type ProductionCanarySample
} from "../src/ci/canary.js";
import {
  gatePolicyBinding,
  loadCanonicalGatePolicy
} from "../src/calibration/gatePolicy.js";
import type { RuntimeManifest } from "../src/core/types.js";
import type { GateResult } from "../src/regression/gate.js";
import type { RunProvenance } from "../src/regression/provenance.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const HASH_E = `sha256:${"e".repeat(64)}`;
const HASH_F = `sha256:${"f".repeat(64)}`;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Stage 8 production CI boundary", () => {
  test("runs the full repository CI suite on the supported Observer isolation backend", async () => {
    const workflow = await readFile(
      path.join(process.cwd(), ".github/workflows/ci.yml"),
      "utf8"
    );

    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).not.toContain("runs-on: ubuntu-latest");
  });

  test("keeps a passing gate diagnostic-only when execution isolation is insufficient", () => {
    const result = assessProductionReadiness({
      gate: passingGate(),
      runtimeManifest: runtimeManifest(),
      provenance: provenance({
        isolation: "working_directory_only",
        permissionMode: "runner_default"
      }),
      isolationManifest: isolationManifest({
        boundary: "working_directory_only",
        networkPolicy: "runner_default",
        targetMount: "read_write"
      }),
      canary: observeOnlyCanary({ status: "PASS" }),
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-ISOLATION-INSUFFICIENT",
      productionBlockingEnabled: false
    });
  });

  test("keeps a passing gate diagnostic-only when Observer qualification is not independently valid", () => {
    const result = assessProductionReadiness({
      gate: passingGate(),
      runtimeManifest: runtimeManifest({ observerQualificationStatus: "missing" }),
      provenance: provenance({ observerQualificationStatus: "missing" }),
      isolationManifest: isolationManifest(),
      canary: observeOnlyCanary({ status: "PASS" }),
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-OBSERVER-UNQUALIFIED",
      productionBlockingEnabled: false
    });
  });

  test("keeps production blocking diagnostic-only until an explicit authorization binds the canary and isolation evidence", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary: readyCanary(isolation, gate)
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-BLOCKING-NOT-AUTHORIZED",
      productionBlockingEnabled: false
    });
  });

  test("prepares an externally signable authorization only after every production prerequisite passes", async () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate);
    const runtime = runtimeManifest();
    const runProvenance = provenance();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");

    const request = prepareProductionBlockingAuthorization({
      gate,
      runtimeManifest: runtime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorizedBy: "authority://workflow-owner",
      authorizedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-08-25T00:00:00.000Z",
      authorityPublicKey: publicKey
    });

    expect(request).toMatchObject({
      artifactType: "production_blocking_authorization_request",
      status: "AWAITING_HUMAN_SIGNATURE",
      prerequisiteAssessment: {
        decision: "DIAGNOSTIC_ONLY",
        ruleId: "PROD-BLOCKING-NOT-AUTHORIZED",
        productionBlockingEnabled: false
      },
      humanCheckpoint: {
        required: true,
        action: "externally_sign_payload",
        keyCustody: "external_only"
      }
    });
    expect(request.unsignedAuthorization).toMatchObject({
      authorizedBy: "authority://workflow-owner",
      scope: {
        targetId: gate.targetId,
        suite: gate.suite
      },
      decision: "enable_blocking",
      attestation: {
        algorithm: "ed25519",
        authorityFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(request.unsignedAuthorization.attestation).not.toHaveProperty(
      "signature"
    );
    expect(request.signingPayloadHash).toBe(
      sha256Text(stableJson(request.unsignedAuthorization))
    );
    await expectSchemaValid(
      "production-blocking-authorization-request.schema.json",
      request
    );

    const signature = sign(
      null,
      Buffer.from(stableJson(request.unsignedAuthorization)),
      privateKey
    ).toString("base64");
    const authorization = finalizeProductionBlockingAuthorization(
      request,
      signature,
      publicKey
    );
    await expectSchemaValid(
      "production-blocking-authorization.schema.json",
      authorization
    );

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });
    expect(result).toMatchObject({
      decision: "PASS",
      ruleId: "PROD-BLOCKING-AUTHORIZED",
      productionBlockingEnabled: true,
      enforcementMode: "production_blocking"
    });
  });

  test("finalizes a CLI authorization signed over the exact emitted payload bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-production-auth-cli-"));
    try {
      const inputDir = path.join(root, "inputs");
      const preparedDir = path.join(root, "prepared");
      const finalizedDir = path.join(root, "finalized");
      await mkdir(inputDir);
      const gate = passingGate();
      const isolation = isolationManifest();
      const inputs = {
        gate: path.join(inputDir, "gate-result.json"),
        runtime: path.join(inputDir, "runtime-manifest.json"),
        provenance: path.join(inputDir, "provenance.json"),
        isolation: path.join(inputDir, "isolation-manifest.json"),
        canary: path.join(inputDir, "canary-report.json")
      };
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyPath = path.join(inputDir, "authority-public.pem");
      await Promise.all([
        writeJson(inputs.gate, gate),
        writeJson(inputs.runtime, runtimeManifest()),
        writeJson(inputs.provenance, provenance()),
        writeJson(inputs.isolation, isolation),
        writeJson(inputs.canary, readyCanary(isolation, gate)),
        writeFile(
          publicKeyPath,
          publicKey.export({ type: "spki", format: "pem" })
        )
      ]);

      await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "ci",
          "prepare-authorization",
          "--gate-result",
          inputs.gate,
          "--runtime-manifest",
          inputs.runtime,
          "--provenance",
          inputs.provenance,
          "--isolation-manifest",
          inputs.isolation,
          "--canary-report",
          inputs.canary,
          "--authorized-by",
          "authority://workflow-owner",
          "--expires-at",
          new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          "--authority-public-key",
          publicKeyPath,
          "--out",
          preparedDir
        ],
        { cwd: process.cwd() }
      );

      const payload = await readFile(
        path.join(
          preparedDir,
          "production-blocking-authorization.signing-payload.txt"
        )
      );
      const request = JSON.parse(
        await readFile(
          path.join(
            preparedDir,
            "production-blocking-authorization-request.json"
          ),
          "utf8"
        )
      );
      expect(payload.equals(Buffer.from(stableJson(request.unsignedAuthorization)))).toBe(
        true
      );

      const signaturePath = path.join(inputDir, "signature.txt");
      await writeFile(
        signaturePath,
        sign(null, payload, privateKey).toString("base64")
      );
      await execa(
        "node",
        [
          "--import",
          "tsx",
          "src/cli/index.ts",
          "ci",
          "finalize-authorization",
          "--request",
          path.join(
            preparedDir,
            "production-blocking-authorization-request.json"
          ),
          "--signature",
          signaturePath,
          "--trusted-authorization-key",
          publicKeyPath,
          "--out",
          finalizedDir
        ],
        { cwd: process.cwd() }
      );

      await expectSchemaValid(
        "production-blocking-authorization.schema.json",
        JSON.parse(
          await readFile(
            path.join(
              finalizedDir,
              "production-blocking-authorization.json"
            ),
            "utf8"
          )
        )
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to prepare an authorization while canary evidence is not production-ready", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const { publicKey } = generateKeyPairSync("ed25519");

    expect(() =>
      prepareProductionBlockingAuthorization({
        gate,
        runtimeManifest: runtimeManifest(),
        provenance: provenance(),
        isolationManifest: isolation,
        canary: readyCanary(isolation, gate, {
          falseNegativeCount: 1
        }),
        authorizedBy: "authority://workflow-owner",
        authorizedAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2026-08-25T00:00:00.000Z",
        authorityPublicKey: publicKey
      })
    ).toThrow("PROD-CANARY-NOT-READY");
  });

  test("rejects a tampered or non-external authorization signature during finalization", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const request = prepareProductionBlockingAuthorization({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary: readyCanary(isolation, gate),
      authorizedBy: "authority://workflow-owner",
      authorizedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-08-25T00:00:00.000Z",
      authorityPublicKey: publicKey
    });
    const signature = sign(
      null,
      Buffer.from(stableJson(request.unsignedAuthorization)),
      privateKey
    ).toString("base64");
    const tampered = structuredClone(request);
    tampered.unsignedAuthorization.scope.suite = "other-suite";

    expect(() =>
      finalizeProductionBlockingAuthorization(tampered, signature, publicKey)
    ).toThrow("authorization request integrity");
    expect(() =>
      finalizeProductionBlockingAuthorization(
        request,
        Buffer.from("not-a-valid-signature").toString("base64"),
        publicKey
      )
    ).toThrow("external authorization signature");
  });

  test("rejects Runner-facing private-key material without leaking the secret or local key path", () => {
    const sensitiveMarker = ["stage8", "sensitive", "key", "material"].join("-");
    const keyMaterial = [
      ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
      sensitiveMarker,
      ["-----END", "PRIVATE", "KEY-----"].join(" ")
    ].join("\n");
    const keyPath = ["/", "secure", "/", ["observer", "private"].join("-"), ".pem"].join("");

    const result = validateProductionIsolationManifest(
      isolationManifest({
        runnerEnvironment: {
          AWB_OBSERVER_PRIVATE_KEY: keyMaterial,
          AWB_OBSERVER_PRIVATE_KEY_PATH: keyPath
        },
        retainedArtifacts: [
          {
            ref: "runner-env.json",
            contentPreview: `observer key at ${keyPath}`
          }
        ]
      })
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "BLOCK",
      reasonCodes: ["PROD_RUNNER_PRIVATE_KEY_EXPOSURE"]
    });
    expect(serialized).not.toContain(sensitiveMarker);
    expect(serialized).not.toContain(keyPath);
  });

  test("blocks Runner-facing private-key exposure even when the evidence gate is not pass-ready", () => {
    const gate = passingGate();
    gate.decision = "DIAGNOSTIC_ONLY";
    gate.ruleId = "GATE-EVIDENCE-NOT-WORKFLOW-TRACE";

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolationManifest({
        runnerEnvironment: {
          HOME: "workspace://ephemeral-home",
          TMPDIR: "workspace://ephemeral-tmp",
          AWB_SIGNING_KEY_PATH: ["/", "secure", "/", ["observer", "private"].join("-"), ".pem"].join("")
        }
      }),
      canary: readyCanary(isolationManifest(), gate)
    });

    expect(result).toMatchObject({
      decision: "BLOCK",
      ruleId: "PROD_RUNNER_PRIVATE_KEY_EXPOSURE",
      productionBlockingEnabled: false
    });
  });

  test("hard gate failures dominate production-readiness evidence", () => {
    const gate = passingGate();
    gate.decision = "BLOCK";
    gate.ruleId = "GATE-HARD-FAILURE";

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolationManifest(),
      canary: readyCanary(isolationManifest(), gate)
    });

    expect(result).toMatchObject({
      decision: "BLOCK",
      ruleId: "PROD-GATE-BLOCK",
      productionBlockingEnabled: false
    });
  });

  test("requires the observe-only canary to meet frozen production thresholds", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate, {
      falseNegativeCount: 1
    });

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary,
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-CANARY-NOT-READY",
      productionBlockingEnabled: false
    });
  });

  test("requires canary rates to match their expected-class denominators", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate, {
      sampleCount: 100,
      expectedPassCount: 20,
      expectedBlockCount: 80,
      falsePositiveCount: 1,
      falsePositiveRate: 0.01
    });

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary,
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-CANARY-NOT-READY"
    });
  });

  test("applies the false-positive threshold to known-good samples, not the full sample set", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate, {
      sampleCount: 100,
      expectedPassCount: 20,
      expectedBlockCount: 80,
      falsePositiveCount: 1,
      falsePositiveRate: 0.05
    });

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary,
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-CANARY-NOT-READY"
    });
  });

  test("requires canary samples to include both known-good and known-bad classes", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate, {
      sampleCount: 100,
      expectedPassCount: 100,
      expectedBlockCount: 0
    });

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtimeManifest(),
      provenance: provenance(),
      isolationManifest: isolation,
      canary,
      authorization: explicitBlockingAuthorization()
    });

    expect(result).toMatchObject({
      decision: "DIAGNOSTIC_ONLY",
      ruleId: "PROD-CANARY-NOT-READY"
    });
  });

  test("enables blocking only for a current signed authorization bound to all evidence", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate);
    const runtime = runtimeManifest();
    const runProvenance = provenance();
    const { publicKey, authorization } = signedAuthorization(
      isolation,
      canary,
      gate,
      runtime,
      runProvenance
    );

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      decision: "PASS",
      ruleId: "PROD-BLOCKING-AUTHORIZED",
      productionBlockingEnabled: true,
      enforcementMode: "production_blocking"
    });
  });

  test("blocks a signed authorization whose evidence bindings were changed", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate);
    const runtime = runtimeManifest();
    const runProvenance = provenance();
    const { publicKey, authorization } = signedAuthorization(
      isolation,
      canary,
      gate,
      runtime,
      runProvenance
    );
    authorization.isolationManifestHash = HASH_F;

    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      decision: "BLOCK",
      ruleId: "PROD-AUTHORIZATION-INVALID",
      productionBlockingEnabled: false
    });
  });

  test("blocks signed authorization when runtime or provenance evidence is substituted", () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate);
    const runtime = runtimeManifest();
    const runProvenance = provenance();
    const { publicKey, authorization } = signedAuthorization(
      isolation,
      canary,
      gate,
      runtime,
      runProvenance
    );
    const substitutedRuntime = structuredClone(runtime);
    substitutedRuntime.runner.capabilitiesHash = HASH_F;
    const substitutedProvenance = structuredClone(runProvenance);
    substitutedProvenance.generatedAt = "2026-07-26T00:00:01.000Z";

    const runtimeResult = assessProductionReadiness({
      gate,
      runtimeManifest: substitutedRuntime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });
    const provenanceResult = assessProductionReadiness({
      gate,
      runtimeManifest: runtime,
      provenance: substitutedProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });

    expect(runtimeResult).toMatchObject({
      decision: "BLOCK",
      ruleId: "PROD-AUTHORIZATION-INVALID",
      productionBlockingEnabled: false
    });
    expect(provenanceResult).toMatchObject({
      decision: "BLOCK",
      ruleId: "PROD-AUTHORIZATION-INVALID",
      productionBlockingEnabled: false
    });
  });

  test("computes observe-only canary safety, stability, runtime, and cost metrics", () => {
    const samples = canarySamples(30);
    const report = buildProductionCanaryReport({
      isolationManifestHash: HASH_A,
      gatePolicyHash: passingGate().gatePolicy.policyHash,
      generatedAt: "2026-07-25T00:00:00.000Z",
      samples
    });

    expect(report).toMatchObject({
      mode: "observe_only",
      status: "PASS",
      sampleCount: 30,
      sampleSetHash: sha256Text(stableJson(samples)),
      expectedPassCount: 15,
      expectedBlockCount: 15,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      flakyCaseCount: 0,
      runtimeSecondsP95: 29,
      costUsdP95: 0.29,
      retentionDecision: "retain_redacted"
    });
  });

  test("counts a diagnostic-only known-good result as a false positive", () => {
    const samples = canarySamples(30);
    samples[0] = {
      ...samples[0]!,
      observedDecision: "DIAGNOSTIC_ONLY",
      repeatedDecisions: ["DIAGNOSTIC_ONLY", "DIAGNOSTIC_ONLY"]
    };

    const report = buildProductionCanaryReport({
      isolationManifestHash: HASH_A,
      gatePolicyHash: passingGate().gatePolicy.policyHash,
      generatedAt: "2026-07-25T00:00:00.000Z",
      samples
    });

    expect(report).toMatchObject({
      status: "FAIL",
      falsePositiveCount: 1,
      falsePositiveRate: 0.066667
    });
  });

  test("validates production isolation, canary, authorization, and CI gate artifacts", async () => {
    const gate = passingGate();
    const isolation = isolationManifest();
    const canary = readyCanary(isolation, gate);
    const runtime = runtimeManifest();
    const runProvenance = provenance();
    const { publicKey, authorization } = signedAuthorization(
      isolation,
      canary,
      gate,
      runtime,
      runProvenance
    );
    const result = assessProductionReadiness({
      gate,
      runtimeManifest: runtime,
      provenance: runProvenance,
      isolationManifest: isolation,
      canary,
      authorization,
      trustedAuthorizationKey: publicKey,
      now: "2026-07-26T00:00:00.000Z"
    });

    await expectSchemaValid(
      "production-isolation-manifest.schema.json",
      isolation
    );
    await expectSchemaValid(
      "production-canary-report.schema.json",
      canary
    );
    await expectSchemaValid(
      "production-blocking-authorization.schema.json",
      authorization
    );
    await expectSchemaValid(
      "production-ci-gate-result.schema.json",
      result
    );
  });

  test("keeps the versioned canary policy config identical to runtime thresholds", async () => {
    const policy = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "configs/ci/production-canary-policy.json"
        ),
        "utf8"
      )
    );

    await expectSchemaValid(
      "production-canary-policy.schema.json",
      policy
    );
    expect(policy).toEqual({
      schemaVersion: "0.1.0",
      policyType: "production_canary",
      ...PRODUCTION_CANARY_POLICY
    });
    expect(PRODUCTION_CANARY_POLICY_HASH).toBe(
      sha256Text(stableJson(PRODUCTION_CANARY_POLICY))
    );
  });
});

function passingGate(): GateResult {
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    decision: "PASS",
    ruleId: "GATE-PASS",
    targetId: "minimal-directory-agent",
    suite: "smoke",
    comparisonClassification: "UNCHANGED",
    comparisonIntegrity: "VALID",
    gatePolicy: gatePolicyBinding(loadCanonicalGatePolicy()),
    reasons: ["Qualified live workflow-trace evidence passed."],
    evidenceRefs: [
      "comparison:comparison-result.json",
      "baseline:workflow-trace.json",
      "candidate:workflow-trace.json",
      "policy:configs/evaluation/gate-policy.json"
    ]
  };
}

function runtimeManifest(
  overrides: {
    observerQualificationStatus?: "missing" | "valid" | "invalid";
  } = {}
): RuntimeManifest {
  const observerQualificationStatus =
    overrides.observerQualificationStatus ?? "valid";
  return {
    schemaVersion: "0.1.0",
    artifactType: "runtime_manifest",
    attemptId: "trace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runner: {
      schemaVersion: "0.1.0",
      name: "codex",
      supported: true,
      executableRef: "codex",
      adapterVersion: "0.1.0",
      executionMode: "live",
      supportsEntrypointKinds: ["file", "cli"],
      tokenSourceDetail: {
        source: "native",
        confidence: "high"
      },
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      },
      capabilitiesHash: HASH_A
    },
    mode: "gate",
    dryRun: false,
    seed: "stage8-seed",
    contractHash: HASH_B,
    caseCount: 1,
    liveTranscriptCount: 0,
    caseSource: "target://materialized",
    workflowTrace: {
      verified: true,
      ref: "workflow-trace.json",
      sha256: HASH_C,
      caseCount: 1,
      eventCount: 8,
      observer: {
        id: "awb-reference-observer",
        version: "1.0.0",
        keyFingerprint: HASH_D,
        qualificationStatus: observerQualificationStatus,
        ...(observerQualificationStatus === "valid"
          ? {
              qualificationRef: "observer-qualification.json" as const,
              qualificationArtifactHash: HASH_E,
              qualificationAuthorityFingerprint: HASH_F
            }
          : {})
      }
    }
  };
}

function provenance(
  overrides: {
    isolation?: RunProvenance["conditions"]["isolation"];
    permissionMode?: RunProvenance["conditions"]["permissionMode"];
    observerQualificationStatus?: "missing" | "valid" | "invalid";
  } = {}
): RunProvenance {
  const observerQualificationStatus =
    overrides.observerQualificationStatus ?? "valid";
  const conditionsBase = {
    suite: "smoke",
    seed: "stage8-seed",
    caseSetHash: HASH_A,
    budgetHash: HASH_B,
    commandPolicyHash: HASH_C,
    runner: {
      name: "codex" as const,
      adapterVersion: "0.1.0",
      capabilitiesHash: HASH_A
    },
    observer: {
      id: "awb-reference-observer",
      version: "1.0.0",
      keyFingerprint: HASH_D,
      qualificationStatus: observerQualificationStatus,
      ...(observerQualificationStatus === "valid"
        ? {
            qualificationRef: "observer-qualification.json" as const,
            qualificationArtifactHash: HASH_E,
            qualificationAuthorityFingerprint: HASH_F
          }
        : {})
    },
    executionMode: "live" as const,
    evidenceKind: "live" as const,
    observationLevel: "workflow_trace" as const,
    isolation: overrides.isolation ?? ("read_only_sandbox" as const),
    permissionMode:
      overrides.permissionMode ?? ("read_only_no_approval" as const),
    environment: {
      runtime: "node" as const,
      runtimeVersion: "v25.8.0",
      platform: "darwin" as const,
      arch: "arm64",
      ci: true
    },
    environmentHash: HASH_D
  };
  return {
    schemaVersion: "0.1.0",
    product: "Agent Workflow Bench",
    generatedAt: "2026-07-26T00:00:00.000Z",
    subject: {
      attemptId: "trace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetId: "minimal-directory-agent",
      contractHash: HASH_B,
      contentHash: HASH_C,
      git: {
        status: "available",
        commit: "a".repeat(40),
        dirty: false
      },
      variant: {
        kind: "baseline"
      }
    },
    conditions: {
      ...conditionsBase,
      conditionsHash: HASH_E
    },
    integrity: {
      status: "VERIFIED_AT_WRITE",
      artifacts: [
        { ref: "suite-result.json", sha256: HASH_A },
        { ref: "runtime-manifest.json", sha256: HASH_B },
        { ref: "workflow-trace.json", sha256: HASH_C },
        { ref: "observer-qualification.json", sha256: HASH_E }
      ]
    }
  };
}

function isolationManifest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0",
    artifactType: "production_isolation_manifest",
    boundary: "linux_container",
    networkPolicy: "deny_by_default",
    targetMount: "read_only",
    runnerHome: "ephemeral",
    runnerTmp: "ephemeral",
    toolProxy: "controlled",
    observerProcess: "external",
    trustAnchor: {
      source: "external",
      observerPublicKeyRef: "observer-public.pem",
      qualificationAuthorityPublicKeyRef: "qualification-authority-public.pem"
    },
    runnerEnvironment: {
      HOME: "workspace://ephemeral-home",
      TMPDIR: "workspace://ephemeral-tmp"
    },
    retainedArtifacts: [
      { ref: "suite-result.json" },
      { ref: "runtime-manifest.json" },
      { ref: "workflow-trace.json" },
      { ref: "observer-qualification.json" }
    ],
    retentionPolicy: {
      redactedOnly: true,
      encryptedAtRest: true,
      maxDays: 14
    },
    checks: {
      directNetworkDenied: true,
      productionWriteDenied: true,
      privateKeyUnreadableByRunner: true,
      observerTraceOutsideRunnerWorkspace: true
    },
    ...overrides
  };
}

function observeOnlyCanary(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0",
    artifactType: "production_canary_report",
    mode: "observe_only",
    status: "PASS",
    policyVersion: PRODUCTION_CANARY_POLICY.policyVersion,
    policyHash: PRODUCTION_CANARY_POLICY_HASH,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sampleSetHash: HASH_B,
    sampleCount: 100,
    expectedPassCount: 50,
    expectedBlockCount: 50,
    falsePositiveCount: 0,
    falsePositiveRate: 0,
    falseNegativeCount: 0,
    falseNegativeRate: 0,
    flakyCaseCount: 0,
    flakyRate: 0,
    runtimeSecondsP95: 60,
    costUsdP95: 1,
    retentionDecision: "retain_redacted",
    isolationManifestHash: HASH_A,
    gatePolicyHash: passingGate().gatePolicy.policyHash,
    ...overrides
  };
}

function explicitBlockingAuthorization(): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0",
    artifactType: "production_blocking_authorization",
    authorizationId: "stage8-auth",
    authorizedBy: "workflow-owner",
    authorizedAt: "2026-07-26T00:00:00.000Z",
    scope: "minimal-directory-agent:smoke",
    canaryReportHash: HASH_A,
    isolationManifestHash: HASH_B,
    gatePolicyHash: passingGate().gatePolicy.policyHash,
    decision: "enable_blocking"
  };
}

function readyCanary(
  isolation: Record<string, unknown>,
  gate: GateResult,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return observeOnlyCanary({
    sampleCount: 100,
    expectedPassCount: 50,
    expectedBlockCount: 50,
    sampleSetHash: HASH_B,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    flakyCaseCount: 0,
    isolationManifestHash: sha256Text(stableJson(isolation)),
    gatePolicyHash: gate.gatePolicy.policyHash,
    ...overrides
  });
}

function canarySamples(count: number): ProductionCanarySample[] {
  return Array.from({ length: count }, (_, index) => ({
    sampleId: `canary-${index + 1}`,
    expectedDecision: index % 2 === 0 ? ("PASS" as const) : ("BLOCK" as const),
    observedDecision: index % 2 === 0 ? ("PASS" as const) : ("BLOCK" as const),
    repeatedDecisions:
      index % 2 === 0
        ? (["PASS", "PASS"] as const)
        : (["BLOCK", "BLOCK"] as const),
    runtimeSeconds: index + 1,
    costUsd: (index + 1) / 100
  }));
}

function signedAuthorization(
  isolation: Record<string, unknown>,
  canary: Record<string, unknown>,
  gate: GateResult,
  runtime = runtimeManifest(),
  runProvenance = provenance()
): {
  publicKey: KeyObject;
  authorization: Record<string, unknown>;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const authorityFingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const authorizationBase = {
    schemaVersion: "0.1.0",
    artifactType: "production_blocking_authorization",
    authorizedBy: "authority://workflow-owner",
    authorizedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2026-08-25T00:00:00.000Z",
    scope: {
      targetId: gate.targetId,
      suite: gate.suite
    },
    canaryReportHash: sha256Text(stableJson(canary)),
    isolationManifestHash: sha256Text(stableJson(isolation)),
    gateResultHash: sha256Text(stableJson(gate)),
    runtimeManifestHash: sha256Text(stableJson(runtime)),
    provenanceHash: sha256Text(stableJson(runProvenance)),
    gatePolicyHash: gate.gatePolicy.policyHash,
    decision: "enable_blocking"
  };
  const authorizationId = sha256Text(stableJson(authorizationBase));
  const unsigned = {
    ...authorizationBase,
    authorizationId,
    attestation: {
      algorithm: "ed25519",
      authorityFingerprint
    }
  };
  return {
    publicKey,
    authorization: {
      ...unsigned,
      attestation: {
        ...unsigned.attestation,
        signature: sign(
          null,
          Buffer.from(stableJson(unsigned)),
          privateKey
        ).toString("base64")
      }
    }
  };
}

async function expectSchemaValid(
  schemaName: string,
  value: unknown
): Promise<void> {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas", schemaName), "utf8")
  ) as object;
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}
