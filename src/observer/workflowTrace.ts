import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CaseRun, RunnerCapability, RunEvent } from "../core/types.js";
import { getImplementedEventIds } from "../evaluation/evaluationContract.js";
import { hashFile, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import { redactSensitiveText } from "../utils/redaction.js";

export interface WorkflowTraceBundle {
  schemaVersion: "0.1.0";
  observer: {
    id: string;
    version: string;
    keyFingerprint: string;
    implementationHash?: string;
    evidenceCapabilities?: string[];
  };
  subject: {
    targetId: string;
    contractHash: string;
    suite: string;
    seed: string;
    caseSetHash: string;
    runner: {
      name: Exclude<RunnerCapability["name"], "simulated">;
      adapterVersion: string;
      version?: string;
      capabilitiesHash: string;
    };
    isolation: "read_only_sandbox" | "working_directory_only";
    permissionMode: "read_only_no_approval" | "runner_default";
    isolationManifest?: {
      backend: "macos-seatbelt" | "linux-oci-docker";
      platform: string;
      runtimeVersion: string;
      image?: string;
      imageId?: string;
      policyHash: string;
      mountManifestHash: string;
      networkMode: "none";
      processPolicy:
        | "seatbelt_process_exec_allowlist"
        | "seccomp_launcher_no_child_process";
      capabilities: {
        drop: string[];
        add: string[];
      };
      noNewPrivileges: boolean;
      readOnlyRootfs: boolean;
      writableMounts: string[];
      canaries: {
        signingKeyRead: "EPERM" | "ABSENT_FROM_MOUNT_NAMESPACE";
        networkDenied: "EPERM" | "NETWORK_UNREACHABLE";
        nestedProcessDenied: "EPERM" | "DENIED";
        outOfScopeWriteDenied: "EPERM" | "EROFS" | "EACCES";
      };
      manifestHash: string;
    };
    model?: string;
  };
  cases: Array<{
    caseId: string;
    templateId: string;
    runId: string;
    events: RunEvent[];
    wallClockSeconds: number;
    tokens: CaseRun["tokens"];
    telemetryCompleteness: number;
  }>;
  attestation: {
    algorithm: "ed25519";
    signature: string;
  };
}

export interface VerifiedWorkflowTrace {
  bundle: WorkflowTraceBundle;
  keyFingerprint: string;
  traceHash: string;
  eventCount: number;
  runs: CaseRun[];
}

export function workflowTraceAttemptId(traceHash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(traceHash)) {
    throw new Error(
      "Workflow trace hash cannot derive a valid attempt identity."
    );
  }
  return `trace-${traceHash.slice("sha256:".length)}`;
}

export async function verifyWorkflowTraceBundle(
  tracePath: string,
  trustedObserverKeyPath: string,
  expected: {
    targetId: string;
    contractHash: string;
    suite: string;
    seed?: string;
    caseSetHash: string;
    caseIds: string[];
    cases?: Array<{ id: string; templateId: string }>;
    runner?: WorkflowTraceBundle["subject"]["runner"];
  }
): Promise<VerifiedWorkflowTrace> {
  const bundle = await readJson<WorkflowTraceBundle>(tracePath);
  assertBundleShape(bundle);

  const trustedKeyBytes = await readFile(trustedObserverKeyPath);
  if (trustedKeyBytes.toString("utf8").includes("PRIVATE KEY")) {
    throw new Error("Trusted observer key must be a public key; private signing keys are not accepted.");
  }
  const publicKey = createPublicKey(trustedKeyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Trusted observer key must be an Ed25519 public key.");
  }
  const keyFingerprint = publicKeyFingerprint(
    publicKey.export({ type: "spki", format: "der" })
  );
  if (bundle.observer.keyFingerprint !== keyFingerprint) {
    throw new Error("Workflow trace observer keyFingerprint does not match the configured trust anchor.");
  }

  const { attestation, ...unsigned } = bundle;
  const signature = Buffer.from(attestation.signature, "base64");
  if (
    signature.length === 0 ||
    !verify(null, Buffer.from(stableJson(unsigned)), publicKey, signature)
  ) {
    throw new Error("Workflow trace signature verification failed.");
  }
  const serializedEvidence = stableJson(unsigned);
  if (redactSensitiveText(serializedEvidence) !== serializedEvidence) {
    throw new Error("Workflow trace evidence must be pre-redacted before observer attestation.");
  }

  if (
    bundle.subject.targetId !== expected.targetId ||
    bundle.subject.contractHash !== expected.contractHash ||
    bundle.subject.suite !== expected.suite
  ) {
    throw new Error("Workflow trace subject does not match the target contract and suite.");
  }
  if (
    expected.seed !== undefined &&
    bundle.subject.seed !== expected.seed
  ) {
    throw new Error(
      "Workflow trace seed does not match the expected execution conditions."
    );
  }
  if (bundle.subject.caseSetHash !== expected.caseSetHash) {
    throw new Error("Workflow trace case set hash does not match the materialized benchmark cases.");
  }
  if (expected.runner && stableJson(bundle.subject.runner) !== stableJson(expected.runner)) {
    throw new Error("Workflow trace runner identity does not match provenance.");
  }

  const expectedCaseIds = [...expected.caseIds].sort();
  const observedCaseIds = bundle.cases.map((item) => item.caseId).sort();
  if (
    new Set(observedCaseIds).size !== observedCaseIds.length ||
    stableJson(observedCaseIds) !== stableJson(expectedCaseIds)
  ) {
    throw new Error("Workflow trace case set does not exactly match the materialized benchmark cases.");
  }
  if (expected.cases) {
    const expectedTemplates = [...expected.cases]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, templateId }) => ({ id, templateId }));
    const observedTemplates = [...bundle.cases]
      .sort((left, right) => left.caseId.localeCompare(right.caseId))
      .map(({ caseId: id, templateId }) => ({ id, templateId }));
    if (stableJson(observedTemplates) !== stableJson(expectedTemplates)) {
      throw new Error("Workflow trace case templates do not match the materialized benchmark cases.");
    }
  }

  const runs = bundle.cases.map((observed) =>
    validateObservedCase(observed, bundle.subject.contractHash, bundle.subject.runner.name)
  );
  return {
    bundle,
    keyFingerprint,
    traceHash: await hashFile(tracePath),
    eventCount: runs.reduce((total, run) => total + run.events.length, 0),
    runs
  };
}

function validateObservedCase(
  observed: WorkflowTraceBundle["cases"][number],
  contractHash: string,
  runnerName: WorkflowTraceBundle["subject"]["runner"]["name"]
): CaseRun {
  if (
    !observed ||
    typeof observed.caseId !== "string" ||
    !observed.caseId ||
    typeof observed.templateId !== "string" ||
    !observed.templateId ||
    typeof observed.runId !== "string" ||
    !observed.runId ||
    !Array.isArray(observed.events)
  ) {
    throw new Error("Workflow trace contains an invalid observed case.");
  }
  if (
    !Number.isFinite(observed.wallClockSeconds) ||
    observed.wallClockSeconds < 0 ||
    !Number.isFinite(observed.telemetryCompleteness) ||
    observed.telemetryCompleteness < 0 ||
    observed.telemetryCompleteness > 1
  ) {
    throw new Error(`Workflow trace metrics are invalid for case ${observed.caseId}.`);
  }
  assertTokens(observed.caseId, observed.tokens);

  const eventIds = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const event of observed.events) {
    assertEvent(observed.caseId, event);
    if (eventIds.has(event.eventId)) {
      throw new Error(`Workflow trace contains duplicate eventId ${event.eventId}.`);
    }
    eventIds.add(event.eventId);
    const eventTime = Date.parse(event.timestamp);
    if (eventTime <= previousTimestamp) {
      throw new Error(
        `Workflow trace case ${observed.caseId} violates required event ordering.`
      );
    }
    previousTimestamp = eventTime;
    if (observerOwnedEventTypes.has(event.type) && event.actor !== "observer") {
      throw new Error(
        `Workflow trace case ${observed.caseId} contains runner-forged Observer evidence.`
      );
    }
  }
  for (const requiredType of [
    "case_start",
    "contract_observed",
    "runner_start",
    "runner_result",
    "runner_exit",
    "token_usage",
    "case_end"
  ] satisfies RunEvent["type"][]) {
    const count = observed.events.filter(
      (event) => event.type === requiredType
    ).length;
    if (count === 0) {
      throw new Error(`Workflow trace case ${observed.caseId} is missing required ${requiredType} evidence.`);
    }
    if (count !== 1) {
      throw new Error(
        `Workflow trace case ${observed.caseId} contains duplicate ${requiredType} lifecycle evidence.`
      );
    }
  }

  const caseStart = observed.events.find((event) => event.type === "case_start")!;
  if (caseStart.payload.caseId !== observed.caseId) {
    throw new Error(`Workflow trace case_start does not match case ${observed.caseId}.`);
  }
  const contractObserved = observed.events.find((event) => event.type === "contract_observed")!;
  if (contractObserved.payload.contractHash !== contractHash) {
    throw new Error(`Workflow trace contract evidence does not match case ${observed.caseId}.`);
  }
  const tokenUsage = observed.events.find((event) => event.type === "token_usage")!;
  if (tokenUsage.payload.total !== observed.tokens.total) {
    throw new Error(`Workflow trace token evidence does not match case ${observed.caseId}.`);
  }
  assertLifecycleOrder(observed);
  assertTemplateEvidence(observed);

  return {
    runId: observed.runId,
    caseId: observed.caseId,
    runner: {
      name: runnerName,
      comparability: {
        workflowScore: "comparable",
        efficiency: "comparable",
        tokenCost: "comparable"
      }
    },
    events: observed.events,
    wallClockSeconds: observed.wallClockSeconds,
    tokens: observed.tokens,
    telemetryCompleteness: observed.telemetryCompleteness
  };
}

function assertBundleShape(bundle: WorkflowTraceBundle): void {
  if (
    !bundle ||
    bundle.schemaVersion !== "0.1.0" ||
    !bundle.observer ||
    typeof bundle.observer.id !== "string" ||
    !bundle.observer.id ||
    typeof bundle.observer.version !== "string" ||
    !bundle.observer.version ||
    typeof bundle.observer.keyFingerprint !== "string" ||
    (bundle.observer.implementationHash !== undefined &&
      (typeof bundle.observer.implementationHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(bundle.observer.implementationHash))) ||
    (bundle.observer.evidenceCapabilities !== undefined &&
      (!Array.isArray(bundle.observer.evidenceCapabilities) ||
        bundle.observer.evidenceCapabilities.some(
          (item) => typeof item !== "string" || !item
        ) ||
        new Set(bundle.observer.evidenceCapabilities).size !==
          bundle.observer.evidenceCapabilities.length)) ||
    !bundle.subject ||
    typeof bundle.subject.targetId !== "string" ||
    typeof bundle.subject.contractHash !== "string" ||
    typeof bundle.subject.suite !== "string" ||
    typeof bundle.subject.seed !== "string" ||
    !bundle.subject.seed ||
    typeof bundle.subject.caseSetHash !== "string" ||
    !bundle.subject.runner ||
    !["codex", "claude", "opencode"].includes(bundle.subject.runner.name) ||
    typeof bundle.subject.runner.adapterVersion !== "string" ||
    typeof bundle.subject.runner.capabilitiesHash !== "string" ||
    !["read_only_sandbox", "working_directory_only"].includes(bundle.subject.isolation) ||
    !["read_only_no_approval", "runner_default"].includes(bundle.subject.permissionMode) ||
    (bundle.subject.isolationManifest !== undefined &&
      !isValidIsolationManifest(bundle.subject.isolationManifest)) ||
    !Array.isArray(bundle.cases) ||
    !bundle.attestation ||
    bundle.attestation.algorithm !== "ed25519" ||
    typeof bundle.attestation.signature !== "string"
  ) {
    throw new Error("Workflow trace bundle is missing required fields.");
  }
  if (bundle.subject.isolationManifest !== undefined) {
    assertWorkflowTraceIsolationBinding(
      bundle.subject.isolation,
      bundle.subject.isolationManifest
    );
  }
}

function isValidIsolationManifest(
  value: WorkflowTraceBundle["subject"]["isolationManifest"]
): boolean {
  if (!value) {
    return false;
  }
  const { manifestHash, ...content } = value;
  const expectedManifestHash = `sha256:${createHash("sha256")
    .update(stableJson(content))
    .digest("hex")}`;
  const backendBindingValid =
    value.backend === "linux-oci-docker"
      ? value.platform === "linux" &&
        value.processPolicy === "seccomp_launcher_no_child_process" &&
        typeof value.image === "string" &&
        value.image.length > 0 &&
        /^sha256:[a-f0-9]{64}$/u.test(value.imageId ?? "") &&
        value.readOnlyRootfs === true &&
        stableJson([...value.writableMounts].sort()) ===
          stableJson(["/tmp", "/workspace"])
      : value.platform === "darwin" &&
        value.processPolicy === "seatbelt_process_exec_allowlist";
  return Boolean(
    ["macos-seatbelt", "linux-oci-docker"].includes(value.backend) &&
      typeof value.platform === "string" &&
      value.platform.length > 0 &&
      typeof value.runtimeVersion === "string" &&
      value.runtimeVersion.length > 0 &&
      /^sha256:[a-f0-9]{64}$/u.test(value.policyHash) &&
      /^sha256:[a-f0-9]{64}$/u.test(value.mountManifestHash) &&
      value.networkMode === "none" &&
      ["seatbelt_process_exec_allowlist", "seccomp_launcher_no_child_process"].includes(
        value.processPolicy
      ) &&
      Array.isArray(value.capabilities.drop) &&
      value.capabilities.drop.length === 1 &&
      value.capabilities.drop[0] === "ALL" &&
      Array.isArray(value.capabilities.add) &&
      value.capabilities.add.length === 0 &&
      value.noNewPrivileges === true &&
      typeof value.readOnlyRootfs === "boolean" &&
      Array.isArray(value.writableMounts) &&
      value.writableMounts.length > 0 &&
      value.canaries &&
      ["EPERM", "ABSENT_FROM_MOUNT_NAMESPACE"].includes(
        value.canaries.signingKeyRead
      ) &&
      ["EPERM", "NETWORK_UNREACHABLE"].includes(
        value.canaries.networkDenied
      ) &&
      ["EPERM", "DENIED"].includes(value.canaries.nestedProcessDenied) &&
      ["EPERM", "EROFS", "EACCES"].includes(
        value.canaries.outOfScopeWriteDenied
      ) &&
      manifestHash === expectedManifestHash &&
      backendBindingValid
  );
}

export function assertWorkflowTraceIsolationManifest(
  value: WorkflowTraceBundle["subject"]["isolationManifest"]
): void {
  if (!isValidIsolationManifest(value)) {
    throw new Error(
      "Workflow trace isolation manifest is stale, unsafe, or backend-inconsistent."
    );
  }
}

export function assertWorkflowTraceIsolationBinding(
  isolation: WorkflowTraceBundle["subject"]["isolation"],
  value: WorkflowTraceBundle["subject"]["isolationManifest"]
): void {
  assertWorkflowTraceIsolationManifest(value);
  if (isolation !== "read_only_sandbox") {
    throw new Error(
      "Workflow trace isolation claim does not match the qualified reference Observer manifest."
    );
  }
}

function assertLifecycleOrder(
  observed: WorkflowTraceBundle["cases"][number]
): void {
  const indexes = new Map<RunEvent["type"], number>();
  observed.events.forEach((event, index) => {
    if (!indexes.has(event.type)) {
      indexes.set(event.type, index);
    }
  });
  const requiredOrder = [
    "case_start",
    "contract_observed",
    "runner_start",
    "runner_result",
    "runner_exit",
    "token_usage",
    "case_end"
  ] satisfies RunEvent["type"][];
  for (let index = 1; index < requiredOrder.length; index += 1) {
    if (
      indexes.get(requiredOrder[index - 1]!)! >=
      indexes.get(requiredOrder[index]!)!
    ) {
      throw new Error(
        `Workflow trace case ${observed.caseId} violates required event ordering.`
      );
    }
  }
  if (
    indexes.get("case_start") !== 0 ||
    indexes.get("case_end") !== observed.events.length - 1
  ) {
    throw new Error(
      `Workflow trace case ${observed.caseId} violates required lifecycle boundaries.`
    );
  }
}

function assertEvent(caseId: string, event: RunEvent): void {
  if (
    !event ||
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp)) ||
    typeof event.actor !== "string" ||
    !event.actor ||
    typeof event.type !== "string" ||
    !runEventTypes.has(event.type as RunEvent["type"]) ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error(`Workflow trace contains an invalid event for case ${caseId}.`);
  }
}

function assertTemplateEvidence(observed: WorkflowTraceBundle["cases"][number]): void {
  if (observed.templateId === "side-effect-deny") {
    const deniedAttempt = observed.events.find(
      (event) =>
        event.type === "side_effect_attempt" &&
        event.payload.policyDecision === "deny" &&
        event.payload.allowed === false
    );
    if (!deniedAttempt) {
      throw new Error(
        `Workflow trace case ${observed.caseId} requires side_effect_attempt evidence with policyDecision=deny and allowed=false.`
      );
    }
  }
}

function assertTokens(caseId: string, tokens: CaseRun["tokens"]): void {
  if (
    !tokens ||
    !Number.isFinite(tokens.input) ||
    tokens.input < 0 ||
    !Number.isFinite(tokens.output) ||
    tokens.output < 0 ||
    !Number.isFinite(tokens.total) ||
    tokens.total < 0 ||
    !Number.isFinite(tokens.wasted) ||
    tokens.wasted < 0 ||
    tokens.input + tokens.output !== tokens.total ||
    !["high", "medium", "low", "unavailable"].includes(tokens.costEstimateConfidence)
  ) {
    throw new Error(`Workflow trace token metrics are invalid for case ${caseId}.`);
  }
}

function publicKeyFingerprint(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

const runEventTypes = new Set<RunEvent["type"]>([
  ...(getImplementedEventIds() as RunEvent["type"][])
]);

const observerOwnedEventTypes = new Set<RunEvent["type"]>([
  "case_start",
  "contract_observed",
  "runner_start",
  "runner_result",
  "runner_exit",
  "token_usage",
  "case_end",
  "filesystem_access",
  "tool_call",
  "process_spawn",
  "network_access",
  "artifact_write",
  "state_read",
  "side_effect_attempt",
  "runner_transcript",
  "hard_failure"
]);
