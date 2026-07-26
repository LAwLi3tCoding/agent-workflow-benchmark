import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { SuiteResult } from "../core/types.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { getReliabilityPolicy } from "../evaluation/evaluationContract.js";
import {
  compareRunArtifacts,
  type ObserverTrustOptions
} from "../regression/compare.js";
import { evaluateGate } from "../regression/gate.js";
import type { RunProvenance } from "../regression/provenance.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import { createAjv2020 } from "../utils/jsonSchema.js";
import {
  analyzeReliabilitySamples,
  type ReliabilityMissingReason,
  type ReliabilityReport,
  type ReliabilitySample,
  type ReliabilitySampleContext,
  type ReliabilityStudy,
  type ReliabilityStudyKind
} from "./reliability.js";

export interface ReliabilityStudyManifest {
  schemaVersion: "0.1.0";
  studyId: string;
  kind: ReliabilityStudyKind;
  seed: string;
  pairs: Array<{
    sampleId: string;
    baseline: string;
    candidate: string;
  }>;
}

class ReliabilityStudySecurityError extends Error {}

export async function runReliabilityStudy(
  studyPath: string,
  trustOptions: ObserverTrustOptions = {}
): Promise<ReliabilityReport> {
  const manifest = await loadReliabilityStudyManifest(studyPath);
  const canonicalStudyRoot = await realpath(path.dirname(studyPath));
  const samples: ReliabilitySample[] = [];

  for (const pair of manifest.pairs) {
    const baseline = await resolvePortableStudyRef(
      canonicalStudyRoot,
      pair.baseline
    );
    const candidate = await resolvePortableStudyRef(
      canonicalStudyRoot,
      pair.candidate
    );
    samples.push(
      await loadReliabilitySample(
        pair.sampleId,
        baseline,
        candidate,
        manifest.seed,
        trustOptions,
        canonicalStudyRoot
      )
    );
  }

  const report = analyzeReliabilitySamples(
    {
      studyId: manifest.studyId,
      kind: manifest.kind,
      seed: manifest.seed
    },
    samples,
    getReliabilityPolicy()
  );
  await assertSchemaValid(
    "reliability-report.schema.json",
    report,
    "Reliability report"
  );
  return report;
}

export async function loadReliabilityStudyManifest(
  studyPath: string
): Promise<ReliabilityStudyManifest> {
  const raw = JSON.parse(await readFile(studyPath, "utf8")) as unknown;
  const schema = JSON.parse(
    await readFile(
      path.join(
        getBenchmarkRoot(),
        "schemas",
        "reliability-study.schema.json"
      ),
      "utf8"
    )
  ) as object;
  const ajv = createAjv2020();
  const validate = ajv.compile<ReliabilityStudyManifest>(schema);
  if (!validate(raw)) {
    throw new Error(
      `Reliability study manifest failed schema validation: ${ajv.errorsText(
        validate.errors
      )}`
    );
  }
  const sampleIds = raw.pairs.map((pair) => pair.sampleId);
  if (new Set(sampleIds).size !== sampleIds.length) {
    throw new Error(
      "Reliability study manifest contains duplicate sampleId values."
    );
  }
  return raw;
}

async function loadReliabilitySample(
  sampleId: string,
  baselineInput: string,
  candidateInput: string,
  seed: string,
  trustOptions: ObserverTrustOptions,
  studyRoot: string
): Promise<ReliabilitySample> {
  try {
    const baselineDir = await resolveRunDir(baselineInput, studyRoot);
    const candidateDir = await resolveRunDir(candidateInput, studyRoot);
    const comparison = await compareRunArtifacts(
      baselineDir,
      candidateDir,
      trustOptions
    );
    const baselineSuite = await readJson<SuiteResult>(
      path.join(baselineDir, "suite-result.json")
    );
    const candidateSuite = await readJson<SuiteResult>(
      path.join(candidateDir, "suite-result.json")
    );
    const baselineProvenance = await readJson<RunProvenance>(
      path.join(baselineDir, "provenance.json")
    );
    const candidateProvenance = await readJson<RunProvenance>(
      path.join(candidateDir, "provenance.json")
    );
    const context = reliabilityContext(candidateProvenance);

    if (
      !runIdMatchesDirectory(baselineSuite.runId, baselineDir) ||
      !runIdMatchesDirectory(candidateSuite.runId, candidateDir)
    ) {
      return missingSample(sampleId, seed, "RUN_INVALID", context);
    }
    if (
      comparison.baseline.provenanceStatus !== "VALID" ||
      comparison.candidate.provenanceStatus !== "VALID"
    ) {
      return missingSample(sampleId, seed, "RUN_INVALID", context);
    }
    if (comparison.comparability.status !== "COMPARABLE") {
      return missingSample(
        sampleId,
        seed,
        comparison.comparability.reasons.includes("SEED_MISMATCH")
          ? "SEED_MISMATCH"
          : "INCOMPARABLE",
        context
      );
    }
    if (
      baselineProvenance.conditions.seed !== seed ||
      candidateProvenance.conditions.seed !== seed
    ) {
      return missingSample(sampleId, seed, "SEED_MISMATCH", context);
    }

    const gate = trustOptions.gatePolicy
      ? evaluateGate(
          comparison,
          {
            status: "VALID",
            reasons: []
          },
          trustOptions.gatePolicy,
          gatePolicyEvidenceRef(trustOptions.gatePolicy)
        )
      : evaluateGate(comparison, {
          status: "VALID",
          reasons: []
        });
    const baselineDimensions = new Map(
      baselineSuite.dimensionScores.map((dimension) => [
        dimension.dimension,
        dimension.score
      ])
    );
    const dimensions = candidateSuite.dimensionScores.flatMap((dimension) => {
      const baseline = baselineDimensions.get(dimension.dimension);
      return baseline === undefined
        ? []
        : [
            {
              dimension: dimension.dimension,
              baseline,
              candidate: dimension.score
            }
          ];
    });

    return {
      status: "observed",
      sampleId,
      evidenceHash: sha256Text(
        stableJson({
          comparison,
          baseline: await runEvidenceDigests(baselineDir),
          candidate: await runEvidenceDigests(candidateDir)
        })
      ),
      attemptFingerprint: sha256Text(
        candidateProvenance.subject.attemptId
      ),
      baselineRunId: baselineSuite.runId,
      candidateRunId: candidateSuite.runId,
      context,
      outcome: {
        classification: comparison.classification,
        gateDecision: gate.decision,
        baselineScore: baselineSuite.cappedSuiteScore,
        candidateScore: candidateSuite.cappedSuiteScore,
        scoreDelta:
          comparison.scoreDelta ??
          candidateSuite.cappedSuiteScore - baselineSuite.cappedSuiteScore,
        telemetryCompleteness: candidateSuite.telemetryCompleteness,
        dimensions,
        cases: candidateSuite.caseResults.map((testCase) => ({
          caseId: testCase.caseId,
          candidateVerdict: testCase.verdict,
          candidateHardFailures: testCase.hardFailures.map((failure) => ({
            code: failure.code,
            severity: failure.severity
          }))
        }))
      }
    };
  } catch (error) {
    if (error instanceof ReliabilityStudySecurityError) {
      throw error;
    }
    return missingSample(
      sampleId,
      seed,
      isMissingFile(error) ? "RUN_MISSING" : "RUN_INVALID"
    );
  }
}

function reliabilityContext(
  provenance: RunProvenance
): ReliabilitySampleContext {
  const observer = provenance.conditions.observer;
  return {
    targetId: provenance.subject.targetId,
    suite: provenance.conditions.suite,
    contractHash: provenance.subject.contractHash,
    caseSetHash: provenance.conditions.caseSetHash,
    conditionsHash: provenance.conditions.conditionsHash,
    runnerFingerprint: sha256Text(
      stableJson(provenance.conditions.runner)
    ),
    environmentFingerprint: provenance.conditions.environmentHash,
    observerVersion: observer?.version ?? "not_applicable",
    model: provenance.conditions.model ?? "unspecified",
    permissionMode: provenance.conditions.permissionMode,
    budgetHash: provenance.conditions.budgetHash,
    seed: provenance.conditions.seed,
    executionMode: provenance.conditions.executionMode,
    evidenceKind: provenance.conditions.evidenceKind,
    observationLevel: provenance.conditions.observationLevel,
    observerQualificationStatus:
      observer?.qualificationStatus ?? "not_applicable"
  };
}

function missingSample(
  sampleId: string,
  seed: string,
  missingReason: ReliabilityMissingReason,
  context: ReliabilitySampleContext = missingContext(seed)
): ReliabilitySample {
  return {
    status: "missing",
    sampleId,
    missingReason,
    context
  };
}

function missingContext(seed: string): ReliabilitySampleContext {
  const unknownHash = sha256Text("missing-reliability-context");
  return {
    targetId: "unknown",
    suite: "unknown",
    contractHash: unknownHash,
    caseSetHash: unknownHash,
    conditionsHash: unknownHash,
    runnerFingerprint: unknownHash,
    environmentFingerprint: unknownHash,
    observerVersion: "unknown",
    model: "unknown",
    permissionMode: "unknown",
    budgetHash: unknownHash,
    seed,
    executionMode: "unknown",
    evidenceKind: "unknown",
    observationLevel: "unknown",
    observerQualificationStatus: "not_applicable"
  };
}

async function runEvidenceDigests(
  runDir: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const ref of [
    "suite-result.json",
    "provenance.json",
    "runtime-manifest.json",
    "workflow-trace.json",
    "observer-qualification.json"
  ]) {
    try {
      result[ref] = await hashFile(path.join(runDir, ref));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
  return result;
}

async function resolveRunDir(
  input: string,
  studyRoot: string
): Promise<string> {
  for (const candidate of [input, path.join(input, "run")]) {
    try {
      await access(path.join(candidate, "suite-result.json"));
      const canonical = await realpath(candidate);
      if (!isWithin(studyRoot, canonical)) {
        throw new ReliabilityStudySecurityError(
          "Reliability study run resolves outside the study root."
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof ReliabilityStudySecurityError) {
        throw error;
      }
      // Try an evaluation's nested run directory.
    }
  }
  throw Object.assign(
    new Error("Reliability study run evidence is missing."),
    { code: "ENOENT" }
  );
}

async function resolvePortableStudyRef(
  studyRoot: string,
  ref: string
): Promise<string> {
  const normalized = ref.replaceAll("\\", "/");
  if (
    !ref ||
    normalized !== ref ||
    path.isAbsolute(ref) ||
    path.posix.normalize(normalized) !== normalized ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      "Reliability study references must be normalized portable relative paths."
    );
  }
  const resolved = path.resolve(studyRoot, ref);
  if (!isWithin(studyRoot, resolved)) {
    throw new Error("Reliability study reference escapes the study root.");
  }
  try {
    const canonical = await realpath(resolved);
    if (!isWithin(studyRoot, canonical)) {
      throw new ReliabilityStudySecurityError(
        "Reliability study reference resolves outside the study root."
      );
    }
    return canonical;
  } catch (error) {
    if (isMissingFile(error)) {
      return resolved;
    }
    throw error;
  }
}

function runIdMatchesDirectory(runId: string, runDir: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId) &&
    runId === path.basename(runDir)
  );
}

async function assertSchemaValid(
  schemaName: string,
  value: unknown,
  label: string
): Promise<void> {
  const schema = JSON.parse(
    await readFile(
      path.join(getBenchmarkRoot(), "schemas", schemaName),
      "utf8"
    )
  ) as object;
  const ajv = createAjv2020();
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(
      `${label} failed schema validation: ${ajv.errorsText(validate.errors)}`
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function gatePolicyEvidenceRef(
  policy: NonNullable<ObserverTrustOptions["gatePolicy"]>
): string {
  return `${policy.policyId}@${policy.policyVersion}#${policy.policyHash}`;
}
