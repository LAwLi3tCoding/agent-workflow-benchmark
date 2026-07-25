import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  HardFailure,
  RunnerCapability,
  RuntimeManifestInput,
  SuiteResult
} from "../core/types.js";
import {
  verifyWorkflowTraceBundle,
  workflowTraceAttemptId,
  type VerifiedWorkflowTrace
} from "../observer/workflowTrace.js";
import {
  assertQualifiedWorkflowTraceEvidence,
  verifyObserverQualificationArtifact,
  type VerifiedObserverQualification
} from "../observer/qualification.js";
import type { ReferenceObserverEvidenceCapability } from "../observer/referenceObserver.js";
import { PRODUCT_NAME } from "../core/product.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import type { RunProvenance } from "./provenance.js";
import { getHardFailureDefinition } from "../evaluation/evaluationContract.js";
import {
  compareGatePolicyBindings,
  gatePolicyBinding,
  loadCanonicalGatePolicy,
  type GatePolicy,
  type GatePolicyBinding
} from "../calibration/policyArtifact.js";

export type ComparisonClassification = "IMPROVED" | "REGRESSED" | "UNCHANGED" | "MIXED" | "HARD_FAILURE" | "INCOMPARABLE";
export type ComparisonReason =
  | "PROVENANCE_MISSING"
  | "PROVENANCE_INVALID"
  | "TARGET_ID_MISMATCH"
  | "CONTRACT_MISMATCH"
  | "SUITE_MISMATCH"
  | "CASE_SET_MISMATCH"
  | "RUNNER_MISMATCH"
  | "EXECUTION_MODE_MISMATCH"
  | "EVIDENCE_KIND_MISMATCH"
  | "OBSERVATION_LEVEL_MISMATCH"
  | "ISOLATION_MISMATCH"
  | "PERMISSION_MISMATCH"
  | "BUDGET_MISMATCH"
  | "COMMAND_POLICY_MISMATCH"
  | "ENVIRONMENT_MISMATCH"
  | "MODEL_MISMATCH"
  | "OBSERVER_MISMATCH"
  | "SEED_MISMATCH"
  | "CONDITIONS_MISMATCH"
  | "GATE_POLICY_MISSING"
  | "GATE_POLICY_VERSION_MISMATCH"
  | "GATE_POLICY_RULES_MISMATCH"
  | "GATE_POLICY_HASH_MISMATCH";

export interface ComparisonCaseDelta {
  caseId: string;
  classification: Exclude<ComparisonClassification, "MIXED">;
  baselineVerdict?: string;
  candidateVerdict?: string;
  scoreDelta: number | null;
  newHardFailures: string[];
  resolvedHardFailures: string[];
}

export interface ComparisonContent {
  schemaVersion: "0.1.0";
  product: typeof PRODUCT_NAME;
  gatePolicy?: GatePolicyBinding;
  baseline: ComparisonRunSummary;
  candidate: ComparisonRunSummary;
  comparability: {
    status: "COMPARABLE" | "INCOMPARABLE";
    reasons: ComparisonReason[];
  };
  classification: ComparisonClassification;
  scoreDelta: number | null;
  caseDeltas: ComparisonCaseDelta[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    hardFailure: number;
    incomparable: number;
  };
  hardFailures: Array<{
    code: string;
    severity: "P0" | "P1";
    source: "baseline" | "candidate" | "comparison";
    caseId?: string;
    why: string;
  }>;
  evidenceRefs: {
    baseline: string[];
    candidate: string[];
  };
}

export interface ComparisonResult extends ComparisonContent {
  integrity: {
    status: "VERIFIED_AT_WRITE";
    comparisonHash: string;
    baselineRef: string;
    candidateRef: string;
    artifacts: Array<{
      ref: string;
      sha256: string;
    }>;
  };
}

export interface ComparisonVerification {
  status: "VALID" | "INVALID";
  reasons: string[];
}

interface ComparisonRunSummary {
  targetId: string;
  suite: string;
  runId: string;
  releaseDecision: SuiteResult["releaseDecision"];
  score: number;
  provenanceStatus: "VALID" | "MISSING" | "INVALID";
  evidenceKind: RunProvenance["conditions"]["evidenceKind"] | "unknown";
  observationLevel: RunProvenance["conditions"]["observationLevel"] | "unknown";
  observerQualificationStatus: NonNullable<
    RunProvenance["conditions"]["observer"]
  >["qualificationStatus"] | "not_applicable";
  gatePolicy?: GatePolicyBinding;
}

interface LoadedRun {
  suite: SuiteResult;
  provenance?: RunProvenance;
  provenanceStatus: "VALID" | "MISSING" | "INVALID";
  provenanceWhy?: string;
}

export interface ObserverTrustOptions {
  trustedObserverKeyPath?: string;
  trustedQualificationKeyPath?: string;
  gatePolicy?: GatePolicy;
}

export async function compareRunArtifacts(
  baselineInput: string,
  candidateInput: string,
  options: ObserverTrustOptions = {}
): Promise<ComparisonContent> {
  const baseline = await loadRun(baselineInput, options);
  const candidate = await loadRun(candidateInput, options);
  const policy = options.gatePolicy ?? loadCanonicalGatePolicy();
  const policyBinding = gatePolicyBinding(policy);
  const reasons = comparisonReasons(baseline, candidate, policyBinding);
  const invalidProvenanceFailures = provenanceFailures(baseline, candidate);
  const candidateHardFailures = collectCandidateHardFailures(candidate.suite);
  const hardFailures = [...invalidProvenanceFailures, ...candidateHardFailures];
  const comparable = reasons.length === 0;
  const caseDeltas = comparable
    ? compareCases(
        baseline.suite,
        candidate.suite,
        policy.rules.classification.minimumMeaningfulScoreDelta
      )
    : incomparableCaseDeltas(baseline.suite, candidate.suite);
  const summary = summarize(caseDeltas);
  const classification =
    invalidProvenanceFailures.length > 0 || candidateHardFailures.length > 0
      ? "HARD_FAILURE"
      : !comparable
        ? "INCOMPARABLE"
        : aggregateClassification(summary);

  return {
    schemaVersion: "0.1.0",
    product: PRODUCT_NAME,
    ...(comparable ? { gatePolicy: policyBinding } : {}),
    baseline: runSummary(baseline),
    candidate: runSummary(candidate),
    comparability: {
      status: comparable ? "COMPARABLE" : "INCOMPARABLE",
      reasons
    },
    classification,
    scoreDelta: comparable ? candidate.suite.cappedSuiteScore - baseline.suite.cappedSuiteScore : null,
    caseDeltas,
    summary,
    hardFailures,
    evidenceRefs: {
      baseline: baseline.provenance
        ? [
            "baseline:suite-result.json",
            "baseline:provenance.json",
            ...(baseline.provenance.conditions.observationLevel === "workflow_trace"
              ? [
                  "baseline:workflow-trace.json",
                  ...(hasQualificationBinding(
                    baseline.provenance.conditions.observer
                  )
                    ? ["baseline:observer-qualification.json"]
                    : [])
                ]
              : [])
          ]
        : ["baseline:suite-result.json"],
      candidate: candidate.provenance
        ? [
            "candidate:suite-result.json",
            "candidate:provenance.json",
            ...(candidate.provenance.conditions.observationLevel ===
            "workflow_trace"
              ? [
                  "candidate:workflow-trace.json",
                  ...(hasQualificationBinding(
                    candidate.provenance.conditions.observer
                  )
                    ? ["candidate:observer-qualification.json"]
                    : [])
                ]
              : [])
          ]
        : ["candidate:suite-result.json"]
    }
  };
}

export async function createComparisonBundle(
  baselineInput: string,
  candidateInput: string,
  outputDir: string,
  options: ObserverTrustOptions = {}
): Promise<ComparisonResult> {
  const evidenceRoot = path.join(outputDir, "evidence");
  const baselineRef = "evidence/baseline";
  const candidateRef = "evidence/candidate";
  await rm(evidenceRoot, { recursive: true, force: true });
  const baselineArtifacts = await snapshotRunArtifacts(baselineInput, path.join(outputDir, baselineRef), baselineRef);
  const candidateArtifacts = await snapshotRunArtifacts(candidateInput, path.join(outputDir, candidateRef), candidateRef);
  const content = await compareRunArtifacts(
    path.join(outputDir, baselineRef),
    path.join(outputDir, candidateRef),
    options
  );
  return {
    ...content,
    integrity: {
      status: "VERIFIED_AT_WRITE",
      comparisonHash: sha256Text(stableJson(content)),
      baselineRef,
      candidateRef,
      artifacts: await Promise.all(
        [...baselineArtifacts, ...candidateArtifacts].map(async (ref) => ({
          ref,
          sha256: await hashFile(path.join(outputDir, ref))
        }))
      )
    }
  };
}

export async function verifyComparisonBundle(
  comparisonPath: string,
  comparison: ComparisonResult,
  options: ObserverTrustOptions = {}
): Promise<ComparisonVerification> {
  const reasons: string[] = [];
  const outputDir = path.dirname(comparisonPath);
  const { integrity, ...content } = comparison;
  if (
    !integrity ||
    integrity.status !== "VERIFIED_AT_WRITE" ||
    !Array.isArray(integrity.artifacts) ||
    !isPortableArtifactRef(integrity.baselineRef) ||
    !isPortableArtifactRef(integrity.candidateRef) ||
    integrity.baselineRef !== "evidence/baseline" ||
    integrity.candidateRef !== "evidence/candidate"
  ) {
    return {
      status: "INVALID",
      reasons: ["Comparison integrity metadata is missing or invalid."]
    };
  }
  if (integrity.comparisonHash !== sha256Text(stableJson(content))) {
    reasons.push("comparison-result.json does not match its integrity hash.");
  }
  const requiredSuiteRefs = [
    path.posix.join(integrity.baselineRef, "suite-result.json"),
    path.posix.join(integrity.candidateRef, "suite-result.json")
  ];
  for (const ref of requiredSuiteRefs) {
    if (!integrity.artifacts.some((artifact) => artifact.ref === ref)) {
      reasons.push(`Required comparison evidence ${ref} is missing from integrity metadata.`);
    }
  }
  for (const artifact of integrity.artifacts) {
    if (
      !isPortableArtifactRef(artifact.ref) ||
      (!artifact.ref.startsWith(`${integrity.baselineRef}/`) &&
        !artifact.ref.startsWith(`${integrity.candidateRef}/`))
    ) {
      reasons.push("Comparison integrity contains a non-portable artifact reference.");
      continue;
    }
    try {
      if (artifact.sha256 !== (await hashFile(path.join(outputDir, artifact.ref)))) {
        reasons.push(`${artifact.ref} digest does not match comparison integrity.`);
      }
    } catch {
      reasons.push(`${artifact.ref} is missing or unreadable.`);
    }
  }
  if (reasons.length === 0) {
    try {
      const recomputed = await compareRunArtifacts(
        path.join(outputDir, integrity.baselineRef),
        path.join(outputDir, integrity.candidateRef),
        options
      );
      if (stableJson(recomputed) !== stableJson(content)) {
        reasons.push("Comparison content does not match the bundled baseline/candidate evidence.");
      }
    } catch {
      reasons.push("Bundled baseline/candidate evidence could not be revalidated.");
    }
  }
  return {
    status: reasons.length === 0 ? "VALID" : "INVALID",
    reasons
  };
}

export function renderComparisonReport(result: ComparisonContent): string {
  return [
    `# ${PRODUCT_NAME} Comparison`,
    "",
    `Target: ${result.candidate.targetId}`,
    `Suite: ${result.candidate.suite}`,
    `Classification: ${result.classification}`,
    `Comparability: ${result.comparability.status}`,
    `Score delta: ${result.scoreDelta ?? "not-comparable"}`,
    "",
    "## Summary",
    `- Improved: ${result.summary.improved}`,
    `- Regressed: ${result.summary.regressed}`,
    `- Unchanged: ${result.summary.unchanged}`,
    `- Hard failure: ${result.summary.hardFailure}`,
    `- Incomparable: ${result.summary.incomparable}`,
    "",
    "## Comparability",
    result.comparability.reasons.length === 0 ? "Matched conditions verified." : result.comparability.reasons.map((reason) => `- ${reason}`).join("\n"),
    "",
    "## Hard Failures",
    result.hardFailures.length === 0
      ? "No candidate or provenance hard failure was observed."
      : result.hardFailures.map((failure) => `- ${failure.source}:${failure.code}${failure.caseId ? ` (${failure.caseId})` : ""} - ${failure.why}`).join("\n"),
    "",
    "## Case Deltas",
    ...result.caseDeltas.map(
      (delta) =>
        `- ${delta.caseId}: ${delta.classification}; scoreDelta=${delta.scoreDelta ?? "not-comparable"}; newHardFailures=${delta.newHardFailures.join(",") || "none"}; resolvedHardFailures=${delta.resolvedHardFailures.join(",") || "none"}`
    )
  ].join("\n");
}

async function snapshotRunArtifacts(input: string, destination: string, refPrefix: string): Promise<string[]> {
  const runDir = await resolveRunDir(input);
  await mkdir(destination, { recursive: true });
  const copied: string[] = [];
  for (const ref of [
    "suite-result.json",
    "provenance.json",
    "runtime-manifest.json",
    "workflow-trace.json",
    "observer-qualification.json"
  ]) {
    try {
      await copyFile(path.join(runDir, ref), path.join(destination, ref));
      copied.push(path.posix.join(refPrefix, ref));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
  return copied;
}

async function loadRun(input: string, options: ObserverTrustOptions): Promise<LoadedRun> {
  const runDir = await resolveRunDir(input);
  const suitePath = path.join(runDir, "suite-result.json");
  const suite = await readJson<SuiteResult>(suitePath);
  const provenancePath = path.join(runDir, "provenance.json");
  let provenance: RunProvenance;
  try {
    provenance = await readJson<RunProvenance>(provenancePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return { suite, provenanceStatus: "MISSING", provenanceWhy: "provenance.json is missing." };
    }
    return { suite, provenanceStatus: "INVALID", provenanceWhy: "provenance.json is not valid JSON." };
  }
  const invalidWhy = await validateProvenance(runDir, suitePath, suite, provenance, options);
  return invalidWhy
    ? { suite, provenance, provenanceStatus: "INVALID", provenanceWhy: invalidWhy }
    : { suite, provenance, provenanceStatus: "VALID" };
}

async function resolveRunDir(input: string): Promise<string> {
  const candidates = [input, path.join(input, "run")];
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "suite-result.json"));
      return candidate;
    } catch {
      // Try the evaluation's run subdirectory next.
    }
  }
  throw new Error(`No suite-result.json found under the provided run artifact.`);
}

async function validateProvenance(
  runDir: string,
  suitePath: string,
  suite: SuiteResult,
  provenance: RunProvenance,
  options: ObserverTrustOptions
): Promise<string | undefined> {
  if (
    !provenance ||
    provenance.schemaVersion !== "0.1.0" ||
    !provenance.subject ||
    !provenance.conditions ||
    !provenance.integrity ||
    !Array.isArray(provenance.integrity.artifacts)
  ) {
    return "Required provenance fields are missing.";
  }
  if (provenance.subject.targetId !== suite.targetId || provenance.conditions.suite !== suite.suite) {
    return "Provenance subject does not match suite-result.json.";
  }
  const { conditionsHash, ...conditionBase } = provenance.conditions;
  if (conditionsHash !== sha256Text(stableJson(conditionBase))) {
    return "Provenance conditionsHash does not match its condition fields.";
  }
  if (provenance.integrity.status !== "VERIFIED_AT_WRITE") {
    return "Provenance integrity status is invalid.";
  }
  const requiresWorkflowTrace = provenance.conditions.observationLevel === "workflow_trace";
  const provenanceObserver = provenance.conditions.observer;
  const hasAnyQualificationBinding = Boolean(
    provenanceObserver?.qualificationRef ||
      provenanceObserver?.qualificationArtifactHash ||
      provenanceObserver?.qualificationAuthorityFingerprint
  );
  const hasCompleteQualificationBinding = Boolean(
    provenanceObserver?.qualificationRef ===
      "observer-qualification.json" &&
      provenanceObserver.qualificationArtifactHash &&
      provenanceObserver.qualificationAuthorityFingerprint
  );
  const requiresQualification =
    requiresWorkflowTrace &&
    provenanceObserver?.qualificationStatus === "valid" &&
    hasCompleteQualificationBinding;
  if (requiresWorkflowTrace && !options.trustedObserverKeyPath) {
    return "workflow_trace provenance requires an external trusted observer public key.";
  }
  if (requiresQualification && !options.trustedQualificationKeyPath) {
    return "Qualified workflow_trace provenance requires an external qualification authority public key.";
  }
  if (!requiresWorkflowTrace && provenance.conditions.observer) {
    return "Observer provenance is only valid for workflow_trace evidence.";
  }
  if (
    requiresWorkflowTrace &&
    (!provenanceObserver ||
      (hasAnyQualificationBinding && !hasCompleteQualificationBinding) ||
      (provenanceObserver.qualificationStatus !== "valid" &&
        hasAnyQualificationBinding))
  ) {
    return "Observer qualification provenance fields are inconsistent.";
  }
  const requiredRefs = [
    "suite-result.json",
    "runtime-manifest.json",
    ...(requiresWorkflowTrace ? ["workflow-trace.json"] : []),
    ...(requiresQualification ? ["observer-qualification.json"] : [])
  ];
  for (const ref of requiredRefs) {
    if (!provenance.integrity.artifacts.some((artifact) => artifact.ref === ref)) {
      return `Required provenance artifact ${ref} is missing.`;
    }
  }
  for (const artifact of provenance.integrity.artifacts) {
    if (!isPortableArtifactRef(artifact.ref)) {
      return "Provenance contains a non-portable artifact reference.";
    }
    try {
      if (artifact.sha256 !== (await hashFile(path.join(runDir, artifact.ref)))) {
        return `${artifact.ref} digest does not match provenance.`;
      }
    } catch {
      return `${artifact.ref} referenced by provenance is missing or unreadable.`;
    }
  }
  const suiteDigest = provenance.integrity.artifacts.find((artifact) => artifact.ref === "suite-result.json");
  if (!suiteDigest || suiteDigest.sha256 !== (await hashFile(suitePath))) {
    return "suite-result.json digest does not match provenance.";
  }
  let runtimeManifest: RuntimeManifestInput;
  try {
    runtimeManifest = await readJson<RuntimeManifestInput>(
      path.join(runDir, "runtime-manifest.json")
    );
  } catch {
    return "runtime-manifest.json is not valid JSON.";
  }
  let verifiedTrace: VerifiedWorkflowTrace | undefined;
  if (requiresWorkflowTrace) {
    try {
      const runner = provenance.conditions.runner;
      if (runner.name === "simulated") {
        return "Simulated runner provenance cannot claim workflow_trace evidence.";
      }
      verifiedTrace = await verifyWorkflowTraceBundle(
        path.join(runDir, "workflow-trace.json"),
        options.trustedObserverKeyPath!,
        {
          targetId: provenance.subject.targetId,
          contractHash: provenance.subject.contractHash,
          suite: provenance.conditions.suite,
          seed: provenance.conditions.seed,
          caseSetHash: provenance.conditions.caseSetHash,
          caseIds: suite.caseResults.map((item) => item.caseId),
          runner: {
            ...runner,
            name: runner.name as Exclude<RunnerCapability["name"], "simulated">
          }
        }
      );
    } catch (error) {
      return error instanceof Error ? error.message : "Workflow trace attestation could not be verified.";
    }
  }
  let verifiedQualification: VerifiedObserverQualification | undefined;
  if (requiresQualification && verifiedTrace) {
    try {
      const implementationHash =
        verifiedTrace.bundle.observer.implementationHash;
      const evidenceCapabilities =
        verifiedTrace.bundle.observer.evidenceCapabilities;
      if (
        !implementationHash ||
        !Array.isArray(evidenceCapabilities) ||
        evidenceCapabilities.length === 0
      ) {
        return "Qualified workflow trace is missing Observer implementation or evidence capability bindings.";
      }
      verifiedQualification =
        await verifyObserverQualificationArtifact(
          path.join(runDir, "observer-qualification.json"),
          options.trustedQualificationKeyPath!,
          {
            observer: {
              id: verifiedTrace.bundle.observer.id,
              version: verifiedTrace.bundle.observer.version,
              keyFingerprint: verifiedTrace.keyFingerprint,
              implementationHash,
              evidenceCapabilities:
                evidenceCapabilities as ReferenceObserverEvidenceCapability[]
            },
            contractHash: provenance.subject.contractHash,
            caseSetHash: provenance.conditions.caseSetHash
          }
        );
      assertQualifiedWorkflowTraceEvidence(
        verifiedTrace,
        verifiedQualification.artifact.observer
      );
      if (
        provenanceObserver!.qualificationArtifactHash !==
          verifiedQualification.artifactHash ||
        provenanceObserver!.qualificationAuthorityFingerprint !==
          verifiedQualification.authorityFingerprint
      ) {
        return "Observer qualification provenance does not match the trusted artifact.";
      }
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Observer qualification could not be verified.";
    }
  }
  const runtimeMismatch = validateRuntimeManifest(
    runtimeManifest,
    suite,
    provenance,
    verifiedTrace,
    verifiedQualification
  );
  if (runtimeMismatch) {
    return runtimeMismatch;
  }
  return undefined;
}

function validateRuntimeManifest(
  runtime: RuntimeManifestInput,
  suite: SuiteResult,
  provenance: RunProvenance,
  verifiedTrace?: VerifiedWorkflowTrace,
  verifiedQualification?: VerifiedObserverQualification
): string | undefined {
  if (
    !runtime ||
    !runtime.runner ||
    (runtime.schemaVersion !== undefined &&
      runtime.schemaVersion !== "0.1.0") ||
    (runtime.artifactType !== undefined &&
      runtime.artifactType !== "runtime_manifest") ||
    runtime.runner.schemaVersion !== "0.1.0" ||
    !["codex", "claude", "opencode", "simulated"].includes(runtime.runner.name) ||
    typeof runtime.runner.supported !== "boolean" ||
    typeof runtime.runner.adapterVersion !== "string" ||
    typeof runtime.runner.capabilitiesHash !== "string" ||
    !["live", "simulated"].includes(runtime.runner.executionMode) ||
    typeof runtime.dryRun !== "boolean" ||
    (runtime.mode !== undefined &&
      !["diagnostic", "gate"].includes(runtime.mode)) ||
    typeof runtime.attemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runtime.attemptId) ||
    typeof runtime.seed !== "string" ||
    !runtime.seed ||
    typeof runtime.contractHash !== "string" ||
    !Number.isInteger(runtime.caseCount) ||
    runtime.caseCount < 0 ||
    (runtime.caseSource !== undefined &&
      ![
        "cases://provided",
        "case://provided",
        "target://materialized",
        "evaluation://cases"
      ].includes(runtime.caseSource))
  ) {
    return "runtime-manifest.json is missing required execution facts.";
  }
  if (
    runtime.attemptId !== provenance.subject.attemptId ||
    runtime.contractHash !== provenance.subject.contractHash ||
    runtime.caseCount !== suite.caseResults.length ||
    runtime.seed !== provenance.conditions.seed
  ) {
    return "Runtime manifest subject does not match suite/provenance evidence.";
  }
  if (
    verifiedTrace &&
    runtime.attemptId !== workflowTraceAttemptId(verifiedTrace.traceHash)
  ) {
    return "Workflow trace attempt identity does not match signed evidence.";
  }
  if (runtime.runner.executionMode !== provenance.conditions.executionMode) {
    return "Runtime execution mode does not match provenance.";
  }

  const expectedRunner =
    runtime.runner.executionMode === "simulated"
      ? {
          name: "simulated" as const,
          adapterVersion: "0.1.0",
          version: undefined,
          capabilitiesHash: sha256Text(stableJson({ name: "simulated", adapterVersion: "0.1.0" }))
        }
      : {
          name: runtime.runner.name,
          adapterVersion: runtime.runner.adapterVersion,
          version: runtime.runner.version,
          capabilitiesHash: runtime.runner.capabilitiesHash
        };
  if (
    provenance.conditions.runner.name !== expectedRunner.name ||
    provenance.conditions.runner.adapterVersion !== expectedRunner.adapterVersion ||
    provenance.conditions.runner.version !== expectedRunner.version ||
    provenance.conditions.runner.capabilitiesHash !== expectedRunner.capabilitiesHash
  ) {
    return "Runtime runner identity does not match provenance.";
  }

  const expectedBoundary =
    verifiedTrace
      ? {
          evidenceKind: "live" as const,
          observationLevel: "workflow_trace" as const,
          isolation: verifiedTrace.bundle.subject.isolation,
          permissionMode: verifiedTrace.bundle.subject.permissionMode
        }
      : runtime.dryRun
      ? {
          evidenceKind: "unknown" as const,
          observationLevel: "capability_only" as const,
          isolation: "unknown" as const,
          permissionMode: "unknown" as const
        }
      : runtime.runner.executionMode === "simulated"
        ? {
            evidenceKind: "simulated" as const,
            observationLevel: "synthetic_events" as const,
            isolation: "synthetic" as const,
            permissionMode: "none" as const
          }
        : runtime.runner.name === "codex"
          ? {
              evidenceKind: "live" as const,
              observationLevel: "contract_summary" as const,
              isolation: "read_only_sandbox" as const,
              permissionMode: "read_only_no_approval" as const
            }
          : runtime.runner.name === "claude"
            ? {
                evidenceKind: "live" as const,
                observationLevel: "contract_summary" as const,
                isolation: "working_directory_only" as const,
                permissionMode: "runner_default" as const
              }
            : {
                evidenceKind: "unknown" as const,
                observationLevel: "capability_only" as const,
                isolation: "unknown" as const,
                permissionMode: "unknown" as const
              };
  if (
    provenance.conditions.evidenceKind !== expectedBoundary.evidenceKind ||
    provenance.conditions.observationLevel !== expectedBoundary.observationLevel ||
    provenance.conditions.isolation !== expectedBoundary.isolation ||
    provenance.conditions.permissionMode !== expectedBoundary.permissionMode
  ) {
    return "Runtime evidence boundary does not match provenance.";
  }

  if (verifiedTrace) {
    const observer = provenance.conditions.observer;
    const runtimeTrace = runtime.workflowTrace;
    if (
      !observer ||
      !runtimeTrace ||
      runtimeTrace.verified !== true ||
      runtimeTrace.ref !== "workflow-trace.json" ||
      runtimeTrace.sha256 !== verifiedTrace.traceHash ||
      runtimeTrace.caseCount !== verifiedTrace.runs.length ||
      runtimeTrace.eventCount !== verifiedTrace.eventCount ||
      runtimeTrace.observer.id !== verifiedTrace.bundle.observer.id ||
      runtimeTrace.observer.version !== verifiedTrace.bundle.observer.version ||
      runtimeTrace.observer.keyFingerprint !== verifiedTrace.keyFingerprint ||
      runtimeTrace.observer.qualificationStatus !== observer.qualificationStatus ||
      runtimeTrace.observer.qualificationRef !== observer.qualificationRef ||
      runtimeTrace.observer.qualificationArtifactHash !==
        observer.qualificationArtifactHash ||
      runtimeTrace.observer.qualificationAuthorityFingerprint !==
        observer.qualificationAuthorityFingerprint ||
      observer.id !== verifiedTrace.bundle.observer.id ||
      observer.version !== verifiedTrace.bundle.observer.version ||
      observer.keyFingerprint !== verifiedTrace.keyFingerprint ||
      (verifiedQualification !== undefined &&
        (observer.qualificationArtifactHash !==
          verifiedQualification.artifactHash ||
          observer.qualificationAuthorityFingerprint !==
            verifiedQualification.authorityFingerprint))
    ) {
      return "Runtime workflow trace facts do not match the trusted observer attestation.";
    }
  } else if (runtime.workflowTrace !== undefined) {
    return "Runtime manifest cannot declare workflow trace facts without trusted attestation.";
  }

  if (runtime.dryRun) {
    if (
      runtime.caseCount !== 0 ||
      !Number.isInteger(runtime.skippedCaseCount) ||
      runtime.skippedCaseCount! < 0 ||
      (runtime.liveTranscriptCount !== undefined && runtime.liveTranscriptCount !== 0)
    ) {
      return "Dry-run runtime counts are invalid.";
    }
  } else if (runtime.runner.executionMode === "simulated") {
    if (runtime.liveTranscriptCount !== 0) {
      return "Simulated runtime cannot contain live transcripts.";
    }
  } else if (verifiedTrace) {
    if (!runtime.runner.supported || runtime.liveTranscriptCount !== 0) {
      return "Attested workflow trace runtime counts are invalid.";
    }
  } else if (
    !runtime.runner.supported ||
    runtime.liveTranscriptCount !== runtime.caseCount
  ) {
    return "Live runtime counts or runner support are invalid.";
  }

  const variant = provenance.subject.variant;
  if (
    (variant.kind === "baseline" && runtime.mutation !== undefined) ||
    (variant.kind === "mutation_overlay" &&
      (!runtime.mutation ||
        runtime.mutation.id !== variant.id ||
        runtime.mutation.type !== variant.type))
  ) {
    return "Runtime mutation facts do not match provenance.";
  }
  return undefined;
}

function isPortableArtifactRef(ref: string): boolean {
  if (!ref || path.isAbsolute(ref)) {
    return false;
  }
  const normalized = path.posix.normalize(ref.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../") && normalized === ref.replaceAll("\\", "/");
}

function comparisonReasons(
  baseline: LoadedRun,
  candidate: LoadedRun,
  policy: GatePolicyBinding
): ComparisonReason[] {
  const reasons: ComparisonReason[] = [];
  const baselinePolicy = compareGatePolicyBindings(
    baseline.suite.gatePolicy,
    policy
  );
  const candidatePolicy = compareGatePolicyBindings(
    candidate.suite.gatePolicy,
    policy
  );
  for (const comparison of [baselinePolicy, candidatePolicy]) {
    if (
      comparison.status === "INCOMPARABLE" &&
      !reasons.includes(comparison.reasonCode)
    ) {
      reasons.push(comparison.reasonCode);
    }
  }
  if (baseline.provenanceStatus === "MISSING" || candidate.provenanceStatus === "MISSING") {
    reasons.push("PROVENANCE_MISSING");
  }
  if (baseline.provenanceStatus === "INVALID" || candidate.provenanceStatus === "INVALID") {
    reasons.push("PROVENANCE_INVALID");
  }
  if (!baseline.provenance || !candidate.provenance || baseline.provenanceStatus !== "VALID" || candidate.provenanceStatus !== "VALID") {
    return reasons;
  }
  const left = baseline.provenance;
  const right = candidate.provenance;
  if (left.subject.targetId !== right.subject.targetId) reasons.push("TARGET_ID_MISMATCH");
  if (left.subject.contractHash !== right.subject.contractHash) reasons.push("CONTRACT_MISMATCH");
  if (left.conditions.suite !== right.conditions.suite) reasons.push("SUITE_MISMATCH");
  if (left.conditions.caseSetHash !== right.conditions.caseSetHash) reasons.push("CASE_SET_MISMATCH");
  if (stableJson(left.conditions.runner) !== stableJson(right.conditions.runner)) reasons.push("RUNNER_MISMATCH");
  if (left.conditions.executionMode !== right.conditions.executionMode) reasons.push("EXECUTION_MODE_MISMATCH");
  if (left.conditions.evidenceKind !== right.conditions.evidenceKind) reasons.push("EVIDENCE_KIND_MISMATCH");
  if (left.conditions.observationLevel !== right.conditions.observationLevel) reasons.push("OBSERVATION_LEVEL_MISMATCH");
  if (left.conditions.isolation !== right.conditions.isolation) reasons.push("ISOLATION_MISMATCH");
  if (left.conditions.permissionMode !== right.conditions.permissionMode) reasons.push("PERMISSION_MISMATCH");
  if (left.conditions.budgetHash !== right.conditions.budgetHash) reasons.push("BUDGET_MISMATCH");
  if (left.conditions.commandPolicyHash !== right.conditions.commandPolicyHash) reasons.push("COMMAND_POLICY_MISMATCH");
  if (left.conditions.environmentHash !== right.conditions.environmentHash) reasons.push("ENVIRONMENT_MISMATCH");
  if (left.conditions.model !== right.conditions.model) reasons.push("MODEL_MISMATCH");
  if (stableJson(left.conditions.observer) !== stableJson(right.conditions.observer)) reasons.push("OBSERVER_MISMATCH");
  if (left.conditions.seed !== right.conditions.seed) reasons.push("SEED_MISMATCH");
  if (left.conditions.conditionsHash !== right.conditions.conditionsHash && reasons.length === 0) reasons.push("CONDITIONS_MISMATCH");
  return reasons;
}

function provenanceFailures(
  baseline: LoadedRun,
  candidate: LoadedRun
): ComparisonContent["hardFailures"] {
  const failures: ComparisonContent["hardFailures"] = [];
  if (baseline.provenanceStatus === "INVALID") {
    const definition = requiredComparisonFailureDefinition("PROVENANCE_INVALID");
    failures.push({
      code: definition.code,
      severity: definition.severity,
      source: "baseline",
      why: definition.why
    });
  }
  if (candidate.provenanceStatus === "INVALID") {
    const definition = requiredComparisonFailureDefinition("PROVENANCE_INVALID");
    failures.push({
      code: definition.code,
      severity: definition.severity,
      source: "candidate",
      why: definition.why
    });
  }
  return failures;
}

function collectCandidateHardFailures(candidate: SuiteResult): ComparisonContent["hardFailures"] {
  return candidate.caseResults.flatMap((caseResult) =>
    caseResult.hardFailures.map((failure) => {
      const definition = canonicalComparisonFailureDefinition(failure.code);
      return {
        code: definition.code,
        severity: definition.severity,
        source: "candidate" as const,
        caseId: caseResult.caseId,
        why: definition.why
      };
    })
  );
}

function compareCases(
  baseline: SuiteResult,
  candidate: SuiteResult,
  minimumMeaningfulScoreDelta: number
): ComparisonCaseDelta[] {
  const baselineById = new Map(baseline.caseResults.map((item) => [item.caseId, item]));
  const candidateById = new Map(candidate.caseResults.map((item) => [item.caseId, item]));
  const caseIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
  return caseIds.map((caseId) => {
    const left = baselineById.get(caseId);
    const right = candidateById.get(caseId);
    if (!left || !right) {
      return {
        caseId,
        classification: "INCOMPARABLE",
        baselineVerdict: left?.verdict,
        candidateVerdict: right?.verdict,
        scoreDelta: null,
        newHardFailures: [],
        resolvedHardFailures: []
      };
    }
    const baselineCodes = new Set(
      left.hardFailures.map((failure) => canonicalComparisonFailureDefinition(failure.code).code)
    );
    const candidateCodes = new Set(
      right.hardFailures.map((failure) => canonicalComparisonFailureDefinition(failure.code).code)
    );
    const newHardFailures = [...candidateCodes].filter((code) => !baselineCodes.has(code)).sort();
    const resolvedHardFailures = [...baselineCodes].filter((code) => !candidateCodes.has(code)).sort();
    const scoreDelta = right.cappedScore - left.cappedScore;
    const classification =
      right.hardFailures.length > 0
        ? "HARD_FAILURE"
        : resolvedHardFailures.length > 0 ||
            verdictRank(right.verdict) > verdictRank(left.verdict) ||
            scoreDelta >= minimumMeaningfulScoreDelta
          ? "IMPROVED"
          : verdictRank(right.verdict) < verdictRank(left.verdict) ||
              scoreDelta <= -minimumMeaningfulScoreDelta
            ? "REGRESSED"
            : "UNCHANGED";
    return {
      caseId,
      classification,
      baselineVerdict: left.verdict,
      candidateVerdict: right.verdict,
      scoreDelta,
      newHardFailures,
      resolvedHardFailures
    };
  });
}

function incomparableCaseDeltas(baseline: SuiteResult, candidate: SuiteResult): ComparisonCaseDelta[] {
  const caseIds = [...new Set([...baseline.caseResults.map((item) => item.caseId), ...candidate.caseResults.map((item) => item.caseId)])].sort();
  return caseIds.map((caseId) => ({
    caseId,
    classification: "INCOMPARABLE",
    scoreDelta: null,
    newHardFailures: [],
    resolvedHardFailures: []
  }));
}

function summarize(caseDeltas: ComparisonCaseDelta[]): ComparisonContent["summary"] {
  return {
    improved: caseDeltas.filter((delta) => delta.classification === "IMPROVED").length,
    regressed: caseDeltas.filter((delta) => delta.classification === "REGRESSED").length,
    unchanged: caseDeltas.filter((delta) => delta.classification === "UNCHANGED").length,
    hardFailure: caseDeltas.filter((delta) => delta.classification === "HARD_FAILURE").length,
    incomparable: caseDeltas.filter((delta) => delta.classification === "INCOMPARABLE").length
  };
}

function aggregateClassification(summary: ComparisonContent["summary"]): ComparisonClassification {
  if (summary.hardFailure > 0) return "HARD_FAILURE";
  if (summary.incomparable > 0) return "INCOMPARABLE";
  if (summary.improved > 0 && summary.regressed > 0) return "MIXED";
  if (summary.regressed > 0) return "REGRESSED";
  if (summary.improved > 0) return "IMPROVED";
  return "UNCHANGED";
}

function runSummary(run: LoadedRun): ComparisonRunSummary {
  return {
    targetId: run.suite.targetId,
    suite: run.suite.suite,
    runId: run.suite.runId,
    releaseDecision: run.suite.releaseDecision,
    score: run.suite.cappedSuiteScore,
    provenanceStatus: run.provenanceStatus,
    evidenceKind: run.provenance?.conditions.evidenceKind ?? "unknown",
    observationLevel: run.provenance?.conditions.observationLevel ?? "unknown",
    observerQualificationStatus: observerQualificationStatus(run),
    ...(run.suite.gatePolicy ? { gatePolicy: run.suite.gatePolicy } : {})
  };
}

function observerQualificationStatus(
  run: LoadedRun
): ComparisonRunSummary["observerQualificationStatus"] {
  if (run.provenance?.conditions.observationLevel !== "workflow_trace") {
    return "not_applicable";
  }
  if (run.provenanceStatus !== "VALID") {
    return "invalid";
  }
  const observer = run.provenance.conditions.observer;
  if (observer?.qualificationStatus === "invalid") {
    return "invalid";
  }
  return hasQualificationBinding(observer)
    ? "valid"
    : "missing";
}

function hasQualificationBinding(
  observer: RunProvenance["conditions"]["observer"]
): boolean {
  return Boolean(
    observer?.qualificationStatus === "valid" &&
      observer.qualificationRef === "observer-qualification.json" &&
      observer.qualificationArtifactHash &&
      observer.qualificationAuthorityFingerprint
  );
}

function canonicalComparisonFailureDefinition(code: string) {
  return (
    getHardFailureDefinition(code) ??
    requiredComparisonFailureDefinition("UNREGISTERED_HARD_FAILURE")
  );
}

function requiredComparisonFailureDefinition(code: string) {
  const definition = getHardFailureDefinition(code);
  if (!definition) {
    throw new Error(`Canonical hard-failure registry is missing implemented code ${code}.`);
  }
  return definition;
}

function verdictRank(verdict: SuiteResult["caseResults"][number]["verdict"]): number {
  if (verdict === "PASS") return 3;
  if (verdict === "PASS_WITH_WARNINGS") return 2;
  if (verdict === "DIAGNOSTIC_ONLY") return 1;
  return 0;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
