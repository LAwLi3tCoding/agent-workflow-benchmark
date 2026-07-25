import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { HardFailure, MutationInput, RunnerCapability, SuiteResult } from "../core/types.js";
import { PRODUCT_NAME } from "../core/product.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import type { RunProvenance } from "./provenance.js";

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
  | "CONDITIONS_MISMATCH";

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
}

interface LoadedRun {
  suite: SuiteResult;
  provenance?: RunProvenance;
  provenanceStatus: "VALID" | "MISSING" | "INVALID";
  provenanceWhy?: string;
}

interface RuntimeManifest {
  runner: {
    name: RunnerCapability["name"];
    supported: boolean;
    adapterVersion: string;
    version?: string;
    capabilitiesHash: string;
    executionMode: RunnerCapability["executionMode"];
  };
  dryRun: boolean;
  contractHash: string;
  caseCount: number;
  skippedCaseCount?: number;
  liveTranscriptCount?: number;
  mutation?: MutationInput;
}

export async function compareRunArtifacts(baselineInput: string, candidateInput: string): Promise<ComparisonContent> {
  const baseline = await loadRun(baselineInput);
  const candidate = await loadRun(candidateInput);
  const reasons = comparisonReasons(baseline, candidate);
  const invalidProvenanceFailures = provenanceFailures(baseline, candidate);
  const candidateHardFailures = collectCandidateHardFailures(candidate.suite);
  const hardFailures = [...invalidProvenanceFailures, ...candidateHardFailures];
  const comparable = reasons.length === 0;
  const caseDeltas = comparable ? compareCases(baseline.suite, candidate.suite) : incomparableCaseDeltas(baseline.suite, candidate.suite);
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
      baseline: baseline.provenance ? ["baseline:suite-result.json", "baseline:provenance.json"] : ["baseline:suite-result.json"],
      candidate: candidate.provenance ? ["candidate:suite-result.json", "candidate:provenance.json"] : ["candidate:suite-result.json"]
    }
  };
}

export async function createComparisonBundle(
  baselineInput: string,
  candidateInput: string,
  outputDir: string
): Promise<ComparisonResult> {
  const evidenceRoot = path.join(outputDir, "evidence");
  const baselineRef = "evidence/baseline";
  const candidateRef = "evidence/candidate";
  await rm(evidenceRoot, { recursive: true, force: true });
  const baselineArtifacts = await snapshotRunArtifacts(baselineInput, path.join(outputDir, baselineRef), baselineRef);
  const candidateArtifacts = await snapshotRunArtifacts(candidateInput, path.join(outputDir, candidateRef), candidateRef);
  const content = await compareRunArtifacts(path.join(outputDir, baselineRef), path.join(outputDir, candidateRef));
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
  comparison: ComparisonResult
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
        path.join(outputDir, integrity.candidateRef)
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
  for (const ref of ["suite-result.json", "provenance.json", "runtime-manifest.json"]) {
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

async function loadRun(input: string): Promise<LoadedRun> {
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
  const invalidWhy = await validateProvenance(runDir, suitePath, suite, provenance);
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
  provenance: RunProvenance
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
  const requiredRefs = ["suite-result.json", "runtime-manifest.json"];
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
  let runtimeManifest: RuntimeManifest;
  try {
    runtimeManifest = await readJson<RuntimeManifest>(path.join(runDir, "runtime-manifest.json"));
  } catch {
    return "runtime-manifest.json is not valid JSON.";
  }
  const runtimeMismatch = validateRuntimeManifest(runtimeManifest, suite, provenance);
  if (runtimeMismatch) {
    return runtimeMismatch;
  }
  return undefined;
}

function validateRuntimeManifest(
  runtime: RuntimeManifest,
  suite: SuiteResult,
  provenance: RunProvenance
): string | undefined {
  if (
    !runtime ||
    !runtime.runner ||
    !["codex", "claude", "opencode", "simulated"].includes(runtime.runner.name) ||
    typeof runtime.runner.supported !== "boolean" ||
    typeof runtime.runner.adapterVersion !== "string" ||
    typeof runtime.runner.capabilitiesHash !== "string" ||
    !["live", "simulated"].includes(runtime.runner.executionMode) ||
    typeof runtime.dryRun !== "boolean" ||
    typeof runtime.contractHash !== "string" ||
    !Number.isInteger(runtime.caseCount) ||
    runtime.caseCount < 0
  ) {
    return "runtime-manifest.json is missing required execution facts.";
  }
  if (
    runtime.contractHash !== provenance.subject.contractHash ||
    runtime.caseCount !== suite.caseResults.length
  ) {
    return "Runtime manifest subject does not match suite/provenance evidence.";
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
    runtime.dryRun
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

function comparisonReasons(baseline: LoadedRun, candidate: LoadedRun): ComparisonReason[] {
  const reasons: ComparisonReason[] = [];
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
  if (left.conditions.conditionsHash !== right.conditions.conditionsHash && reasons.length === 0) reasons.push("CONDITIONS_MISMATCH");
  return reasons;
}

function provenanceFailures(
  baseline: LoadedRun,
  candidate: LoadedRun
): ComparisonContent["hardFailures"] {
  const failures: ComparisonContent["hardFailures"] = [];
  if (baseline.provenanceStatus === "INVALID") {
    failures.push({
      code: "PROVENANCE_INVALID",
      source: "baseline",
      why: baseline.provenanceWhy ?? "Baseline provenance is invalid."
    });
  }
  if (candidate.provenanceStatus === "INVALID") {
    failures.push({
      code: "PROVENANCE_INVALID",
      source: "candidate",
      why: candidate.provenanceWhy ?? "Candidate provenance is invalid."
    });
  }
  return failures;
}

function collectCandidateHardFailures(candidate: SuiteResult): ComparisonContent["hardFailures"] {
  return candidate.caseResults.flatMap((caseResult) =>
    caseResult.hardFailures.map((failure) => ({
      code: failure.code,
      source: "candidate" as const,
      caseId: caseResult.caseId,
      why: failure.why
    }))
  );
}

function compareCases(baseline: SuiteResult, candidate: SuiteResult): ComparisonCaseDelta[] {
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
    const baselineCodes = new Set(left.hardFailures.map((failure) => failure.code));
    const candidateCodes = new Set(right.hardFailures.map((failure) => failure.code));
    const newHardFailures = [...candidateCodes].filter((code) => !baselineCodes.has(code)).sort();
    const resolvedHardFailures = [...baselineCodes].filter((code) => !candidateCodes.has(code)).sort();
    const scoreDelta = right.cappedScore - left.cappedScore;
    const classification =
      right.hardFailures.length > 0
        ? "HARD_FAILURE"
        : resolvedHardFailures.length > 0 || verdictRank(right.verdict) > verdictRank(left.verdict) || scoreDelta > 0
          ? "IMPROVED"
          : verdictRank(right.verdict) < verdictRank(left.verdict) || scoreDelta < 0
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
    observationLevel: run.provenance?.conditions.observationLevel ?? "unknown"
  };
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
