import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BenchmarkCase, ContractModel } from "../core/types.js";
import {
  getBenchmarkRoot,
  loadTargetPack
} from "../core/targetRegistry.js";
import {
  getImplementedHardFailureCodes
} from "../evaluation/evaluationContract.js";
import {
  DEFAULT_GOLD_CORPUS_PATH,
  evaluateGoldCorpus,
  loadGoldCorpus
} from "../evaluation/goldCorpus.js";
import { materializeSmokeSuite } from "../generator/materialize.js";
import { profileTarget } from "../profiler/profileTarget.js";
import { scoreCase } from "../scorer/score.js";
import { semanticCaseSetHash } from "../regression/provenance.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import {
  REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
  observeWithReferenceObserver,
  referenceObserverImplementationHash,
  type ReferenceObserverEvidenceCapability
} from "./referenceObserver.js";
import {
  verifyWorkflowTraceBundle,
  type VerifiedWorkflowTrace,
  type WorkflowTraceBundle
} from "./workflowTrace.js";

const EXPLICIT_QUALIFICATION_CHECK_IDS = [
  "known-good",
  "event-missing",
  "event-order",
  "runner-forged-event",
  "wrong-public-key",
  "private-key-leak",
  "network-blind-spot",
  "tool-blind-spot",
  "repeat-run"
] as const;

export const OBSERVER_QUALIFICATION_REQUIRED_CHECK_IDS = [
  ...EXPLICIT_QUALIFICATION_CHECK_IDS,
  ...getImplementedHardFailureCodes("P0").map((code) => `p0:${code}`)
];

export type ObserverQualificationCheckKind =
  | "known_good"
  | "p0_mutation"
  | "event_omission"
  | "event_order"
  | "runner_forgery"
  | "wrong_key"
  | "private_key_leak"
  | "network_blind_spot"
  | "tool_blind_spot"
  | "repeat";

export interface ObserverQualificationCheck {
  id: string;
  kind: ObserverQualificationCheckKind;
  failureCode?: string;
  expectedDecision: "PASS" | "BLOCK";
  actualDecision: "PASS" | "BLOCK";
  status: "PASS" | "FAIL";
  evidenceHash: string;
  why: string;
}

export interface ObserverQualificationArtifact {
  schemaVersion: "0.1.0";
  artifactType: "observer-qualification";
  qualificationId: string;
  qualifiedAt: string;
  expiresAt: string;
  observer: {
    id: string;
    version: string;
    keyFingerprint: string;
    implementationHash: string;
    evidenceCapabilities: readonly ReferenceObserverEvidenceCapability[];
  };
  subject: {
    contractHash: string;
    caseSetHash: string;
    evaluationContractHash: string;
    workflowTraceSchemaHash: string;
    qualificationSuiteHash: string;
  };
  results: {
    decision: "valid" | "invalid";
    p0DetectionRate: number;
    falsePassCount: number;
    knownGoodPassed: boolean;
    repeatCount: number;
    repeatAgreement: number;
    privateKeyVisibleToRunner: boolean;
  };
  checks: ObserverQualificationCheck[];
  integrity: {
    status: "VERIFIED_AT_WRITE";
    contentHash: string;
  };
  attestation: {
    algorithm: "ed25519";
    authorityFingerprint: string;
    signature: string;
  };
}

export interface VerifiedObserverQualification {
  artifact: ObserverQualificationArtifact;
  artifactHash: string;
  authorityFingerprint: string;
}

export interface ObserverQualificationExpectedBinding {
  observer: ObserverQualificationArtifact["observer"];
  contractHash: string;
  caseSetHash: string;
}

export interface ObserverQualificationReport {
  schemaVersion: "0.1.0";
  reportType: "observer_qualification";
  decision: "valid" | "invalid";
  observer: ObserverQualificationArtifact["observer"];
  p0DetectionRate: number;
  falsePassCount: number;
  knownGoodPassed: boolean;
  repeatCount: number;
  repeatAgreement: number;
  privateKeyVisibleToRunner: boolean;
  checks: ObserverQualificationCheck[];
  artifactRef: "observer-qualification.json";
  trustAction: "none";
}

export async function runReferenceObserverQualification(options: {
  contract: ContractModel;
  cases: BenchmarkCase[];
  observerId: string;
  observerVersion: string;
  observerPrivateKeyPath: string;
  qualificationAuthorityPrivateKeyPath: string;
  outputDir: string;
}): Promise<{
  artifact: ObserverQualificationArtifact;
  report: ObserverQualificationReport;
}> {
  await assertQualificationKeyIsolation(
    options.observerPrivateKeyPath,
    options.outputDir,
    "Observer"
  );
  await assertQualificationKeyIsolation(
    options.qualificationAuthorityPrivateKeyPath,
    options.outputDir,
    "Qualification authority"
  );
  if (
    (await realpath(options.observerPrivateKeyPath)) ===
    (await realpath(options.qualificationAuthorityPrivateKeyPath))
  ) {
    throw new Error(
      "Observer and qualification authority must use distinct Ed25519 private keys."
    );
  }
  const observerPrivateKey = await readEd25519PrivateKey(
    options.observerPrivateKeyPath,
    "Observer"
  );
  const observerPublicKey = createPublicKey(observerPrivateKey);
  const authorityPrivateKey = await readEd25519PrivateKey(
    options.qualificationAuthorityPrivateKeyPath,
    "Qualification authority"
  );
  const authorityPublicKey = createPublicKey(authorityPrivateKey);
  const observerKeyFingerprint = publicKeyFingerprint(observerPublicKey);
  if (
    observerKeyFingerprint === publicKeyFingerprint(authorityPublicKey)
  ) {
    throw new Error(
      "Observer and qualification authority must use independent Ed25519 key pairs."
    );
  }
  const caseSetHash = semanticCaseSetHash(options.cases);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "awb-observer-qualification-")
  );

  try {
    const knownGoodRuns = await runKnownGoodRepeats({
      workspace,
      observerPrivateKeyPath: options.observerPrivateKeyPath,
      observerPublicKey,
      observerId: options.observerId,
      observerVersion: options.observerVersion,
      contract: options.contract,
      caseSetHash
    });
    const knownGood = knownGoodRuns[0]!;
    const mutationOutcomes = await runObserverMutationChecks({
      workspace,
      verified: knownGood,
      observerPrivateKey,
      observerPublicKey,
      observerPrivateKeyPath: options.observerPrivateKeyPath
    });
    const goldReport = await evaluateCanonicalQualificationCorpus();
    const privateKeyVisibleToRunner = await runnerSawPrivateKey(
      knownGoodRuns,
      workspace,
      options.observerPrivateKeyPath,
      observerPrivateKey
    );
    const checks: ObserverQualificationCheck[] = [];
    checks.push(
      qualificationCheck(
        "known-good",
        "known_good",
        "PASS",
        knownGoodRuns.every((item) => item.eventCount > 0) ? "PASS" : "BLOCK",
        knownGoodRuns.map((item) => item.traceHash),
        "Reference Observer trace verifies and contains complete evidence."
      )
    );
    checks.push(
      qualificationCheck(
        "event-missing",
        "event_omission",
        "BLOCK",
        mutationOutcomes.eventMissing,
        [knownGood.traceHash, "event-missing"],
        "Required lifecycle omission is rejected."
      ),
      qualificationCheck(
        "event-order",
        "event_order",
        "BLOCK",
        mutationOutcomes.eventOrder,
        [knownGood.traceHash, "event-order"],
        "Lifecycle reordering is rejected."
      ),
      qualificationCheck(
        "runner-forged-event",
        "runner_forgery",
        "BLOCK",
        mutationOutcomes.runnerForgery,
        [knownGood.traceHash, "runner-forgery"],
        "Runner-authored Observer evidence is rejected."
      ),
      qualificationCheck(
        "wrong-public-key",
        "wrong_key",
        "BLOCK",
        mutationOutcomes.wrongKey,
        [knownGood.traceHash, "wrong-key"],
        "A different Observer trust anchor cannot verify the trace."
      ),
      qualificationCheck(
        "private-key-leak",
        "private_key_leak",
        "BLOCK",
        mutationOutcomes.privateKeyLeak,
        [knownGood.traceHash, "private-key-environment-scan"],
        "Observer signing key material and its path are absent from Runner evidence."
      ),
      qualificationCheck(
        "network-blind-spot",
        "network_blind_spot",
        "BLOCK",
        mutationOutcomes.networkBlindSpot,
        [knownGood.traceHash, "network-blind-spot"],
        "A Runner direct-network canary is denied by the Observer boundary and qualified traces require its Observer-owned evidence."
      ),
      qualificationCheck(
        "tool-blind-spot",
        "tool_blind_spot",
        "BLOCK",
        mutationOutcomes.toolBlindSpot,
        [knownGood.traceHash, "tool-blind-spot"],
        "A Runner nested-tool canary is denied by the Observer boundary and qualified traces require its Observer-owned evidence."
      ),
      qualificationCheck(
        "repeat-run",
        "repeat",
        "PASS",
        knownGoodRuns.length === 3 ? "PASS" : "BLOCK",
        knownGoodRuns.map((item) => item.traceHash),
        "Three independent repeats agree on verification and evidence completeness."
      )
    );

    for (const failureCode of getImplementedHardFailureCodes("P0")) {
      const actualDecision = p0MutationDecision(
        failureCode,
        mutationOutcomes,
        goldReport,
        knownGood,
        options.cases
      );
      checks.push(
        qualificationCheck(
          `p0:${failureCode}`,
          "p0_mutation",
          "BLOCK",
          actualDecision,
          [goldReport.manifestHash, failureCode],
          `P0 mutation ${failureCode} must be blocked.`,
          failureCode
        )
      );
    }

    const p0Checks = checks.filter((item) => item.kind === "p0_mutation");
    const p0DetectionRate = ratio(
      p0Checks.filter((item) => item.actualDecision === "BLOCK").length,
      p0Checks.length
    );
    const falsePassCount = checks.filter(
      (item) =>
        item.expectedDecision === "BLOCK" && item.actualDecision === "PASS"
    ).length;
    const repeatAgreement =
      knownGoodRuns.length === 3 &&
      knownGoodRuns.every((item) => item.eventCount === knownGood.eventCount)
        ? 1
        : 0;
    const knownGoodPassed =
      checks.find((item) => item.id === "known-good")?.status === "PASS";
    const decision =
      checks.every((item) => item.status === "PASS") &&
      p0DetectionRate === 1 &&
      falsePassCount === 0 &&
      knownGoodPassed &&
      repeatAgreement === 1 &&
      !privateKeyVisibleToRunner
        ? "valid"
        : "invalid";
    const workflowTraceSchemaHash = await hashFile(
      path.join(getBenchmarkRoot(), "schemas/workflow-trace.schema.json")
    );
    const evaluationContractHash = await hashFile(
      path.join(
        getBenchmarkRoot(),
        "configs",
        "evaluation",
        "evaluation-contract.yaml"
      )
    );
    const qualifiedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.parse(qualifiedAt) + 30 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const observer = {
      id: options.observerId,
      version: options.observerVersion,
      keyFingerprint: observerKeyFingerprint,
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: [...REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES]
    };
    const subject = {
      contractHash: options.contract.contractHash,
      caseSetHash,
      evaluationContractHash,
      workflowTraceSchemaHash,
      qualificationSuiteHash: observerQualificationSuiteHash()
    };
    const results = {
      decision,
      p0DetectionRate,
      falsePassCount,
      knownGoodPassed: Boolean(knownGoodPassed),
      repeatCount: knownGoodRuns.length,
      repeatAgreement,
      privateKeyVisibleToRunner
    } as const;
    const qualificationId = sha256Text(
      stableJson({ observer, subject, results, checks })
    );
    const content = {
      schemaVersion: "0.1.0" as const,
      artifactType: "observer-qualification" as const,
      qualificationId,
      qualifiedAt,
      expiresAt,
      observer,
      subject,
      results,
      checks
    };
    const integrity = {
      status: "VERIFIED_AT_WRITE" as const,
      contentHash: sha256Text(stableJson(content))
    };
    const authorityFingerprint = publicKeyFingerprint(authorityPublicKey);
    const signature = sign(
      null,
      Buffer.from(stableJson({ ...content, integrity })),
      authorityPrivateKey
    ).toString("base64");
    const artifact: ObserverQualificationArtifact = {
      ...content,
      integrity,
      attestation: {
        algorithm: "ed25519",
        authorityFingerprint,
        signature
      }
    };
    const report: ObserverQualificationReport = {
      schemaVersion: "0.1.0",
      reportType: "observer_qualification",
      decision,
      observer,
      p0DetectionRate,
      falsePassCount,
      knownGoodPassed: Boolean(knownGoodPassed),
      repeatCount: knownGoodRuns.length,
      repeatAgreement,
      privateKeyVisibleToRunner,
      checks,
      artifactRef: "observer-qualification.json",
      trustAction: "none"
    };
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(
      path.join(options.outputDir, "observer-qualification.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      path.join(options.outputDir, "observer-qualification-report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    return { artifact, report };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function verifyObserverQualificationArtifact(
  artifactPath: string,
  trustedQualificationAuthorityKeyPath: string,
  expected: ObserverQualificationExpectedBinding
): Promise<VerifiedObserverQualification> {
  const artifact = await readJson<ObserverQualificationArtifact>(artifactPath);
  assertQualificationShape(artifact);
  const authorityKeyBytes = await readFile(
    trustedQualificationAuthorityKeyPath
  );
  if (authorityKeyBytes.toString("utf8").includes("PRIVATE KEY")) {
    throw new Error(
      "Trusted qualification authority key must be a public key; private keys are not accepted."
    );
  }
  const authorityPublicKey = createPublicKey(authorityKeyBytes);
  if (authorityPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      "Trusted qualification authority key must be an Ed25519 public key."
    );
  }
  const authorityFingerprint = publicKeyFingerprint(authorityPublicKey);
  if (artifact.attestation.authorityFingerprint !== authorityFingerprint) {
    throw new Error(
      "Observer qualification authority fingerprint does not match the configured trust anchor."
    );
  }
  if (authorityFingerprint === artifact.observer.keyFingerprint) {
    throw new Error(
      "Observer and qualification authority trust anchors must be independent."
    );
  }
  if (
    artifact.observer.implementationHash !==
    referenceObserverImplementationHash()
  ) {
    throw new Error(
      "Observer qualification implementation binding is stale and does not match the current implementation."
    );
  }
  const { attestation, integrity, ...content } = artifact;
  if (integrity.contentHash !== sha256Text(stableJson(content))) {
    throw new Error("Observer qualification integrity content hash is invalid.");
  }
  if (
    artifact.qualificationId !==
    sha256Text(
      stableJson({
        observer: artifact.observer,
        subject: artifact.subject,
        results: artifact.results,
        checks: artifact.checks
      })
    )
  ) {
    throw new Error("Observer qualification id does not match its bound content.");
  }
  const signature = Buffer.from(attestation.signature, "base64");
  if (
    signature.length === 0 ||
    !verify(
      null,
      Buffer.from(stableJson({ ...content, integrity })),
      authorityPublicKey,
      signature
    )
  ) {
    throw new Error("Observer qualification signature verification failed.");
  }
  if (
    stableJson(artifact.observer) !== stableJson(expected.observer) ||
    artifact.subject.contractHash !== expected.contractHash ||
    artifact.subject.caseSetHash !== expected.caseSetHash
  ) {
    throw new Error(
      "Observer qualification observer, contract, or case-set binding does not match the trace."
    );
  }
  const workflowTraceSchemaHash = await hashFile(
    path.join(getBenchmarkRoot(), "schemas/workflow-trace.schema.json")
  );
  const evaluationContractHash = await hashFile(
    path.join(
      getBenchmarkRoot(),
      "configs",
      "evaluation",
      "evaluation-contract.yaml"
    )
  );
  if (
    artifact.subject.evaluationContractHash !== evaluationContractHash ||
    artifact.subject.workflowTraceSchemaHash !== workflowTraceSchemaHash ||
    artifact.subject.qualificationSuiteHash !==
      observerQualificationSuiteHash()
  ) {
    throw new Error(
      "Observer qualification evaluation contract, schema, or suite binding is stale or invalid."
    );
  }
  if (
    !Number.isFinite(Date.parse(artifact.qualifiedAt)) ||
    !Number.isFinite(Date.parse(artifact.expiresAt)) ||
    Date.parse(artifact.qualifiedAt) > Date.now() + 5 * 60 * 1_000 ||
    Date.parse(artifact.expiresAt) <= Date.parse(artifact.qualifiedAt) ||
    Date.parse(artifact.expiresAt) <= Date.now()
  ) {
    throw new Error("Observer qualification has expired or has invalid dates.");
  }
  const requiredIds = [...OBSERVER_QUALIFICATION_REQUIRED_CHECK_IDS].sort();
  const actualIds = artifact.checks.map((item) => item.id).sort();
  const requiredP0Codes = getImplementedHardFailureCodes("P0").sort();
  const actualP0Codes = artifact.checks
    .filter((item) => item.kind === "p0_mutation")
    .map((item) => item.failureCode)
    .filter((item): item is string => Boolean(item))
    .sort();
  const p0Checks = artifact.checks.filter(
    (item) => item.kind === "p0_mutation"
  );
  const computedP0DetectionRate = ratio(
    p0Checks.filter((item) => item.actualDecision === "BLOCK").length,
    p0Checks.length
  );
  const computedFalsePassCount = artifact.checks.filter(
    (item) =>
      item.expectedDecision === "BLOCK" &&
      item.actualDecision === "PASS"
  ).length;
  const expectedDecisionFor = (
    check: ObserverQualificationCheck
  ): "PASS" | "BLOCK" =>
    check.id === "known-good" || check.id === "repeat-run"
      ? "PASS"
      : "BLOCK";
  if (
    stableJson(artifact.observer.evidenceCapabilities) !==
      stableJson(REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES) ||
    stableJson(actualIds) !== stableJson(requiredIds) ||
    stableJson(actualP0Codes) !== stableJson(requiredP0Codes) ||
    artifact.checks.some(
      (item) =>
        item.kind !== expectedQualificationKind(item.id) ||
        (item.id.startsWith("p0:") &&
          item.failureCode !== item.id.slice("p0:".length)) ||
        item.expectedDecision !== expectedDecisionFor(item) ||
        item.actualDecision !== item.expectedDecision ||
        item.status !==
          (item.actualDecision === item.expectedDecision ? "PASS" : "FAIL") ||
        !/^sha256:[a-f0-9]{64}$/u.test(item.evidenceHash)
    ) ||
    artifact.results.decision !== "valid" ||
    artifact.results.p0DetectionRate !== computedP0DetectionRate ||
    artifact.results.p0DetectionRate !== 1 ||
    artifact.results.falsePassCount !== computedFalsePassCount ||
    artifact.results.falsePassCount !== 0 ||
    artifact.results.knownGoodPassed !==
      (artifact.checks.find((item) => item.id === "known-good")
        ?.actualDecision === "PASS") ||
    artifact.results.repeatCount < 3 ||
    artifact.results.repeatAgreement !== 1 ||
    artifact.results.privateKeyVisibleToRunner
  ) {
    throw new Error(
      "Observer qualification acceptance metrics or required checks are invalid."
    );
  }
  return {
    artifact,
    artifactHash: await hashFile(artifactPath),
    authorityFingerprint
  };
}

export function assertQualifiedWorkflowTraceEvidence(
  verifiedTrace: VerifiedWorkflowTrace,
  expected: ObserverQualificationArtifact["observer"]
): void {
  const observer = verifiedTrace.bundle.observer;
  if (
    observer.id !== expected.id ||
    observer.version !== expected.version ||
    observer.keyFingerprint !== expected.keyFingerprint ||
    observer.implementationHash !== expected.implementationHash ||
    stableJson(observer.evidenceCapabilities) !==
      stableJson(expected.evidenceCapabilities)
  ) {
    throw new Error(
      "Workflow trace does not match the qualified Observer implementation and evidence capabilities."
    );
  }
  const requiredEventByCapability: Record<
    ReferenceObserverEvidenceCapability,
    string
  > = {
    filesystem: "filesystem_access",
    tool: "tool_call",
    process: "process_spawn",
    network: "network_access",
    artifact: "artifact_write",
    state: "state_read",
    side_effect: "side_effect_attempt",
    token: "token_usage"
  };
  for (const observedCase of verifiedTrace.bundle.cases) {
    for (const capability of expected.evidenceCapabilities) {
      const eventType = requiredEventByCapability[capability];
      const evidence = observedCase.events.find(
        (event) =>
          event.type === eventType &&
          event.actor === "observer" &&
          event.payload.observedBy === "reference_observer" &&
          (capability !== "network" ||
            (event.payload.boundaryProbe === true &&
              event.payload.attempted === true &&
              event.payload.allowed === false &&
              event.payload.policyDecision === "deny" &&
              event.payload.outcomeCode === "EPERM")) &&
          (capability !== "tool" ||
            (event.payload.boundaryProbe === true &&
              event.payload.attempted === true &&
              event.payload.allowed === false &&
              event.payload.policyDecision === "deny" &&
              event.payload.outcomeCode === "EPERM"))
      );
      if (!evidence) {
        throw new Error(
          `Qualified workflow trace case ${observedCase.caseId} is missing Observer-owned ${eventType} evidence.`
        );
      }
    }
  }
}

export function observerQualificationSuiteHash(): string {
  return sha256Text(
    stableJson({
      protocol: "awb-observer-qualification/1",
      requiredCheckIds: OBSERVER_QUALIFICATION_REQUIRED_CHECK_IDS,
      requiredP0FailureCodes: getImplementedHardFailureCodes("P0"),
      requiredEvidenceCapabilities: REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES,
      p0DetectionRate: 1,
      falsePassCount: 0,
      repeatCount: 3,
      repeatAgreement: 1
    })
  );
}

function expectedQualificationKind(
  id: string
): ObserverQualificationCheckKind | undefined {
  if (id.startsWith("p0:")) {
    return "p0_mutation";
  }
  const kinds: Record<string, ObserverQualificationCheckKind> = {
    "known-good": "known_good",
    "event-missing": "event_omission",
    "event-order": "event_order",
    "runner-forged-event": "runner_forgery",
    "wrong-public-key": "wrong_key",
    "private-key-leak": "private_key_leak",
    "network-blind-spot": "network_blind_spot",
    "tool-blind-spot": "tool_blind_spot",
    "repeat-run": "repeat"
  };
  return kinds[id];
}

async function runKnownGoodRepeats(options: {
  workspace: string;
  observerPrivateKeyPath: string;
  observerPublicKey: KeyObject;
  observerId: string;
  observerVersion: string;
  contract: ContractModel;
  caseSetHash: string;
}): Promise<VerifiedWorkflowTrace[]> {
  const runnerPath = path.join(options.workspace, "qualification-runner.mjs");
  await writeFile(
    runnerPath,
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import { spawnSync } from "node:child_process";',
      'import net from "node:net";',
      'import path from "node:path";',
      "const workspace = process.env.AWB_OBSERVED_WORKSPACE;",
      'await mkdir(path.join(workspace, "artifacts"), { recursive: true });',
      'await writeFile(path.join(workspace, "artifacts", "result.json"), "{\\"ok\\":true}\\n");',
      "const visible = Object.fromEntries(",
      "  Object.entries(process.env).filter(([key, value]) =>",
      "    /observer|private|signing|secret|credential/i.test(key) || /PRIVATE KEY/i.test(value ?? '')",
      "  )",
      ");",
      'await writeFile(path.join(workspace, "artifacts", "runner-environment.json"), JSON.stringify(visible));',
      "const networkDenied = await new Promise((resolve) => {",
      '  const socket = net.connect({ host: "127.0.0.1", port: 9 });',
      '  socket.once("connect", () => { socket.destroy(); resolve("CONNECTED"); });',
      '  socket.once("error", (error) => resolve(error?.code ?? "UNKNOWN"));',
      "});",
      'const nested = spawnSync("/bin/echo", ["qualification-boundary-canary"]);',
      "await writeFile(",
      '  path.join(workspace, "artifacts", "isolation-probe.json"),',
      "  JSON.stringify({",
      "    networkDenied,",
      '    nestedProcessDenied: nested.error?.code ?? (nested.status === 0 ? "ALLOWED" : "UNKNOWN")',
      "  })",
      ");",
      'process.stdout.write("qualification runner complete\\n");'
    ].join("\n")
  );
  const observerPublicKeyPath = path.join(
    options.workspace,
    "observer-public.pem"
  );
  await writeFile(
    observerPublicKeyPath,
    options.observerPublicKey.export({ type: "spki", format: "pem" })
  );
  const traceRoot = path.join(options.workspace, "observer-traces");
  await mkdir(traceRoot, { recursive: true });
  const results: VerifiedWorkflowTrace[] = [];
  for (let index = 0; index < 3; index += 1) {
    const runRoot = path.join(options.workspace, `repeat-${index + 1}`);
    await mkdir(path.join(runRoot, "state"), { recursive: true });
    await writeFile(
      path.join(runRoot, "state", "workflow.json"),
      '{"status":"ready"}\n'
    );
    const tracePath = path.join(traceRoot, `repeat-${index + 1}.json`);
    await observeWithReferenceObserver({
      privateKeyPath: options.observerPrivateKeyPath,
      outputPath: tracePath,
      request: {
        schemaVersion: "0.1.0",
        observer: {
          id: options.observerId,
          version: options.observerVersion
        },
        subject: {
          targetId: options.contract.targetId,
          contractHash: options.contract.contractHash,
          suite: "smoke",
          caseSetHash: options.caseSetHash,
          runner: {
            name: "codex",
            adapterVersion: "awb-qualification-fixture-1",
            version: "fixture",
            capabilitiesHash: sha256Text(
              stableJson({
                runner: "qualification-fixture",
                version: 1
              })
            )
          },
          isolation: "read_only_sandbox",
          permissionMode: "read_only_no_approval",
          model: "qualification-fixture"
        },
        cases: [
          {
            caseId: "qualification-known-good",
            templateId: "observer-qualification",
            runId: `qualification-known-good-${index + 1}`,
            workspaceRoot: runRoot,
            command: {
              executable: process.execPath,
              args: [runnerPath],
              cwd: runRoot
            },
            artifactPaths: [
              "artifacts/result.json",
              "artifacts/runner-environment.json",
              "artifacts/isolation-probe.json"
            ],
            statePaths: ["state/workflow.json"],
            protectedPaths: ["protected"]
          }
        ]
      }
    });
    const isolationProbe = await readJson<{
      networkDenied: string;
      nestedProcessDenied: string;
    }>(path.join(runRoot, "artifacts", "isolation-probe.json"));
    if (
      isolationProbe.networkDenied !== "EPERM" ||
      isolationProbe.nestedProcessDenied !== "EPERM"
    ) {
      throw new Error(
        "Observer qualification Runner bypass canaries were not denied by the isolation boundary."
      );
    }
    const verified = await verifyWorkflowTraceBundle(
      tracePath,
      observerPublicKeyPath,
      {
        targetId: options.contract.targetId,
        contractHash: options.contract.contractHash,
        suite: "smoke",
        caseSetHash: options.caseSetHash,
        caseIds: ["qualification-known-good"],
        cases: [
          {
            id: "qualification-known-good",
            templateId: "observer-qualification"
          }
        ]
      }
    );
    assertQualifiedWorkflowTraceEvidence(verified, {
      id: options.observerId,
      version: options.observerVersion,
      keyFingerprint: publicKeyFingerprint(options.observerPublicKey),
      implementationHash: referenceObserverImplementationHash(),
      evidenceCapabilities: [...REFERENCE_OBSERVER_EVIDENCE_CAPABILITIES]
    });
    results.push(verified);
  }
  return results;
}

async function runObserverMutationChecks(options: {
  workspace: string;
  verified: VerifiedWorkflowTrace;
  observerPrivateKey: KeyObject;
  observerPublicKey: KeyObject;
  observerPrivateKeyPath: string;
}): Promise<{
  eventMissing: "PASS" | "BLOCK";
  eventOrder: "PASS" | "BLOCK";
  runnerForgery: "PASS" | "BLOCK";
  wrongKey: "PASS" | "BLOCK";
  privateKeyLeak: "PASS" | "BLOCK";
  networkBlindSpot: "PASS" | "BLOCK";
  toolBlindSpot: "PASS" | "BLOCK";
  secretLeak: "PASS" | "BLOCK";
}> {
  const observerPublicKeyPath = path.join(
    options.workspace,
    "mutation-observer-public.pem"
  );
  await writeFile(
    observerPublicKeyPath,
    options.observerPublicKey.export({ type: "spki", format: "pem" })
  );
  const expected = {
    targetId: options.verified.bundle.subject.targetId,
    contractHash: options.verified.bundle.subject.contractHash,
    suite: options.verified.bundle.subject.suite,
    caseSetHash: options.verified.bundle.subject.caseSetHash,
    caseIds: options.verified.bundle.cases.map((item) => item.caseId),
    cases: options.verified.bundle.cases.map((item) => ({
      id: item.caseId,
      templateId: item.templateId
    }))
  };
  const qualifiedObserver = {
    id: options.verified.bundle.observer.id,
    version: options.verified.bundle.observer.version,
    keyFingerprint: options.verified.keyFingerprint,
    implementationHash:
      options.verified.bundle.observer.implementationHash!,
    evidenceCapabilities:
      options.verified.bundle.observer
        .evidenceCapabilities as ReferenceObserverEvidenceCapability[]
  };
  const mutation = async (
    id: string,
    mutate: (bundle: WorkflowTraceBundle) => void,
    requireQualifiedEvidence = false
  ): Promise<"PASS" | "BLOCK"> => {
    const bundle = structuredClone(options.verified.bundle);
    mutate(bundle);
    const tracePath = path.join(options.workspace, `${id}.json`);
    await writeSignedBundle(tracePath, bundle, options.observerPrivateKey);
    try {
      const verified = await verifyWorkflowTraceBundle(
        tracePath,
        observerPublicKeyPath,
        expected
      );
      if (requireQualifiedEvidence) {
        assertQualifiedWorkflowTraceEvidence(verified, qualifiedObserver);
      }
      return "PASS";
    } catch {
      return "BLOCK";
    }
  };
  const wrongKeys = generateKeyPairSync("ed25519");
  const wrongPublicKeyPath = path.join(
    options.workspace,
    "wrong-observer-public.pem"
  );
  await writeFile(
    wrongPublicKeyPath,
    wrongKeys.publicKey.export({ type: "spki", format: "pem" })
  );
  let wrongKey: "PASS" | "BLOCK" = "PASS";
  try {
    await verifyWorkflowTraceBundle(
      path.join(options.workspace, "observer-traces", "repeat-1.json"),
      wrongPublicKeyPath,
      expected
    );
  } catch {
    wrongKey = "BLOCK";
  }
  const privateKeyLeakWorkspace = path.join(
    options.workspace,
    "private-key-leak"
  );
  await mkdir(path.join(privateKeyLeakWorkspace, "state"), {
    recursive: true
  });
  await writeFile(
    path.join(privateKeyLeakWorkspace, "state", "workflow.json"),
    '{"status":"ready"}\n'
  );
  let privateKeyLeak: "PASS" | "BLOCK" = "PASS";
  try {
    await observeWithReferenceObserver({
      privateKeyPath: options.observerPrivateKeyPath,
      outputPath: path.join(
        options.workspace,
        "observer-traces",
        "private-key-leak.json"
      ),
      request: {
        schemaVersion: "0.1.0",
        observer: {
          id: options.verified.bundle.observer.id,
          version: options.verified.bundle.observer.version
        },
        subject: options.verified.bundle.subject,
        cases: [
          {
            caseId: "qualification-private-key-leak",
            templateId: "observer-qualification",
            runId: "qualification-private-key-leak",
            workspaceRoot: privateKeyLeakWorkspace,
            command: {
              executable: process.execPath,
              args: ["--version"],
              cwd: privateKeyLeakWorkspace,
              env: {
                OBSERVER_PRIVATE_KEY:
                  options.observerPrivateKey
                    .export({ type: "pkcs8", format: "pem" })
                    .toString()
              }
            },
            artifactPaths: [],
            statePaths: ["state/workflow.json"],
            protectedPaths: ["protected"]
          }
        ]
      }
    });
  } catch {
    privateKeyLeak = "BLOCK";
  }
  return {
    eventMissing: await mutation("event-missing", (bundle) => {
      bundle.cases[0]!.events = bundle.cases[0]!.events.filter(
        (event) => event.type !== "runner_exit"
      );
    }),
    eventOrder: await mutation("event-order", (bundle) => {
      const events = bundle.cases[0]!.events;
      const resultIndex = events.findIndex(
        (event) => event.type === "runner_result"
      );
      const exitIndex = events.findIndex(
        (event) => event.type === "runner_exit"
      );
      [events[resultIndex], events[exitIndex]] = [
        events[exitIndex]!,
        events[resultIndex]!
      ];
    }),
    runnerForgery: await mutation("runner-forgery", (bundle) => {
      const event = bundle.cases[0]!.events.find(
        (item) => item.type === "artifact_write"
      )!;
      event.actor = "runner";
    }),
    wrongKey,
    privateKeyLeak,
    networkBlindSpot: await mutation(
      "network-blind-spot",
      (bundle) => {
        bundle.cases[0]!.events = bundle.cases[0]!.events.filter(
          (event) => event.type !== "network_access"
        );
      },
      true
    ),
    toolBlindSpot: await mutation(
      "tool-blind-spot",
      (bundle) => {
        bundle.cases[0]!.events = bundle.cases[0]!.events.filter(
          (event) => event.type !== "tool_call"
        );
      },
      true
    ),
    secretLeak: await mutation("secret-leak", (bundle) => {
      const events = bundle.cases[0]!.events;
      events.splice(events.length - 1, 0, {
        eventId: "qualification-secret-leak",
        timestamp: new Date(
          Date.parse(events[events.length - 2]!.timestamp) + 1
        ).toISOString(),
        type: "runner_transcript",
        actor: "observer",
        payload: {
          text: ["Authorization: ", "Be", "arer qualification-secret"].join("")
        }
      });
    })
  };
}

function p0MutationDecision(
  failureCode: string,
  mutations: Awaited<ReturnType<typeof runObserverMutationChecks>>,
  goldReport: ReturnType<typeof evaluateGoldCorpus>,
  knownGood: VerifiedWorkflowTrace,
  cases: BenchmarkCase[]
): "PASS" | "BLOCK" {
  const observerMutationByCode: Record<string, "PASS" | "BLOCK"> = {
    TRACE_EVENT_MISSING: mutations.eventMissing,
    TRACE_EVENT_ORDER_INVALID: mutations.eventOrder,
    OBSERVER_EVENT_FORGED: mutations.runnerForgery,
    SECRET_LEAK: mutations.secretLeak,
    PROVENANCE_INVALID: mutations.wrongKey
  };
  if (observerMutationByCode[failureCode]) {
    return observerMutationByCode[failureCode]!;
  }
  if (failureCode === "UNREGISTERED_HARD_FAILURE") {
    const testCase = cases[0];
    if (!testCase) {
      return "PASS";
    }
    const observed = knownGood.runs[0]!;
    const scored = scoreCase(testCase, {
      ...observed,
      caseId: testCase.id,
      events: [
        ...observed.events.slice(0, -1),
        {
          eventId: "qualification-unregistered-hard-failure",
          timestamp: new Date(
            Date.parse(observed.events.at(-1)!.timestamp) - 1
          ).toISOString(),
          type: "hard_failure",
          actor: "observer",
          payload: {
            code: "QUALIFICATION_UNKNOWN_FAILURE",
            severity: "P0",
            why: "qualification mutation"
          }
        },
        observed.events.at(-1)!
      ]
    });
    return scored.hardFailures.some(
      (item) => item.code === "UNREGISTERED_HARD_FAILURE"
    )
      ? "BLOCK"
      : "PASS";
  }
  const results = goldReport.results.filter(
    (item) =>
      item.failureCode === failureCode && item.control === "known_bad"
  );
  return results.length > 0 &&
    results.every(
      (item) =>
        item.mutationKilled &&
        item.falsePass === false &&
        item.observedVerdict === "FAIL"
    )
    ? "BLOCK"
    : "PASS";
}

async function runnerSawPrivateKey(
  runs: VerifiedWorkflowTrace[],
  workspace: string,
  privateKeyPath: string,
  privateKey: KeyObject
): Promise<boolean> {
  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString()
    .trim();
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    const serialized = stableJson(run.bundle);
    let environment = "";
    try {
      environment = await readFile(
        path.join(
          workspace,
          `repeat-${index + 1}`,
          "artifacts",
          "runner-environment.json"
        ),
        "utf8"
      );
    } catch {
      return true;
    }
    if (
      serialized.includes(privatePem) ||
      serialized.includes(privateKeyPath) ||
      environment.includes(privatePem) ||
      environment.includes(privateKeyPath) ||
      Object.keys(JSON.parse(environment) as object).length > 0
    ) {
      return true;
    }
  }
  return false;
}

function qualificationCheck(
  id: string,
  kind: ObserverQualificationCheckKind,
  expectedDecision: "PASS" | "BLOCK",
  actualDecision: "PASS" | "BLOCK",
  evidence: string[],
  why: string,
  failureCode?: string
): ObserverQualificationCheck {
  return {
    id,
    kind,
    ...(failureCode ? { failureCode } : {}),
    expectedDecision,
    actualDecision,
    status: expectedDecision === actualDecision ? "PASS" : "FAIL",
    evidenceHash: sha256Text(stableJson(evidence)),
    why
  };
}

async function evaluateCanonicalQualificationCorpus() {
  const corpus = await loadGoldCorpus(DEFAULT_GOLD_CORPUS_PATH);
  const target = await loadTargetPack(corpus.manifest.targetId);
  const contract = (await profileTarget(target)).contract;
  const cases = materializeSmokeSuite(contract).cases;
  return evaluateGoldCorpus(corpus, contract, cases);
}

async function writeSignedBundle(
  outputPath: string,
  bundle: WorkflowTraceBundle,
  privateKey: KeyObject
): Promise<void> {
  const { attestation: _attestation, ...unsigned } = bundle;
  const signature = sign(
    null,
    Buffer.from(stableJson(unsigned)),
    privateKey
  ).toString("base64");
  await writeFile(
    outputPath,
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

async function readEd25519PrivateKey(
  keyPath: string,
  label: string
): Promise<KeyObject> {
  const key = createPrivateKey(await readFile(keyPath));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} key must be an Ed25519 private key.`);
  }
  return key;
}

function publicKeyFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function assertQualificationShape(
  artifact: ObserverQualificationArtifact
): void {
  if (
    !artifact ||
    artifact.schemaVersion !== "0.1.0" ||
    artifact.artifactType !== "observer-qualification" ||
    !artifact.qualificationId ||
    !artifact.observer?.id ||
    !artifact.observer.version ||
    !artifact.observer.keyFingerprint ||
    !artifact.observer.implementationHash ||
    !Array.isArray(artifact.observer.evidenceCapabilities) ||
    !artifact.subject?.contractHash ||
    !artifact.subject.caseSetHash ||
    !artifact.subject.evaluationContractHash ||
    !artifact.subject.workflowTraceSchemaHash ||
    !artifact.subject.qualificationSuiteHash ||
    !artifact.results ||
    !Array.isArray(artifact.checks) ||
    !artifact.integrity ||
    artifact.integrity.status !== "VERIFIED_AT_WRITE" ||
    !artifact.attestation ||
    artifact.attestation.algorithm !== "ed25519" ||
    !artifact.attestation.authorityFingerprint ||
    !artifact.attestation.signature
  ) {
    throw new Error(
      "Observer qualification artifact is missing required fields."
    );
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function assertQualificationKeyIsolation(
  keyPath: string,
  outputDir: string,
  label: string
): Promise<void> {
  const resolvedKeyPath = await realpath(keyPath);
  const repositoryRoot = await realpath(getBenchmarkRoot());
  const outputRoot = await canonicalQualificationPath(outputDir);
  if (
    isPathWithin(repositoryRoot, resolvedKeyPath) ||
    isPathWithin(outputRoot, resolvedKeyPath)
  ) {
    throw new Error(
      `${label} private key must remain outside the repository and qualification artifacts.`
    );
  }
}

async function canonicalQualificationPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    const parent = path.dirname(value);
    if (parent === value) {
      return path.resolve(value);
    }
    return path.join(
      await canonicalQualificationPath(parent),
      path.basename(value)
    );
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}
