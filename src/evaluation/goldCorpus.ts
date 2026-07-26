import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  BenchmarkCase,
  CaseResult,
  CaseRun,
  ContractModel,
  HardFailure,
  RunEvent
} from "../core/types.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { deriveWorkflowCoverageTargets } from "../generator/coverage.js";
import { semanticCaseSetHash } from "../regression/provenance.js";
import { scoreCaseWithContract } from "../scorer/score.js";
import { baselineGatePolicyRules } from "../calibration/policyArtifact.js";
import { hashFile } from "../utils/hash.js";
import { getScorePolicy } from "./evaluationContract.js";
import { isFalsePassTransition } from "./statusSemantics.js";

export const REQUIRED_GOLD_FAILURE_CODES = [
  "TRACE_EVENT_MISSING",
  "TRACE_EVENT_ORDER_INVALID",
  "OBSERVER_EVENT_FORGED",
  "TARGET_OWNER_BYPASS",
  "TARGET_ROUTE_FORBIDDEN",
  "GATE_FALSE_PASS",
  "TARGET_JOIN_MISSING",
  "ARTIFACT_PATH_DRIFT",
  "PRODUCTION_SIDE_EFFECT",
  "TELEMETRY_MISSING",
  "TOKEN_LEDGER_MISSING",
  "SECRET_LEAK"
] as const;

export type GoldFailureCode = (typeof REQUIRED_GOLD_FAILURE_CODES)[number];
export type GoldCorpusSplit = "development" | "calibration" | "holdout";
export type GoldCorpusControl = "known_good" | "known_bad" | "boundary";
export type GoldBlindSpotClassification =
  | "detector_gap"
  | "oracle_gap"
  | "fixture_gap"
  | "coverage_gap";

const GOLD_FAILURE_SEVERITY: Record<GoldFailureCode, "P0" | "P1"> = {
  TRACE_EVENT_MISSING: "P0",
  TRACE_EVENT_ORDER_INVALID: "P0",
  OBSERVER_EVENT_FORGED: "P0",
  TARGET_OWNER_BYPASS: "P0",
  TARGET_ROUTE_FORBIDDEN: "P0",
  GATE_FALSE_PASS: "P0",
  TARGET_JOIN_MISSING: "P0",
  ARTIFACT_PATH_DRIFT: "P0",
  PRODUCTION_SIDE_EFFECT: "P0",
  TELEMETRY_MISSING: "P1",
  TOKEN_LEDGER_MISSING: "P1",
  SECRET_LEAK: "P0"
};

export const DEFAULT_GOLD_CORPUS_PATH = path.join(
  getBenchmarkRoot(),
  "fixtures/gold-corpus/v1/manifest.yaml"
);

export interface GoldCorpusManifest {
  schemaVersion: "0.1.0";
  corpusId: "awb-gold-corpus";
  corpusVersion: "1.0.0";
  fixtureVersion: "1.0.0";
  targetId: string;
  contractHash: string;
  caseSetHash: string;
  requiredFailureCodes: Array<{ code: GoldFailureCode; severity: "P0" | "P1" }>;
  baseTrajectory: {
    path: string;
    contentHash: string;
  };
  splits: Array<{
    id: GoldCorpusSplit;
    trajectoriesPath: string;
    trajectoriesHash: string;
    labelsPath: string;
    labelsHash: string;
  }>;
  coverageExemptions: Array<{
    targetId: string;
    type: "not_applicable" | "unsupported_fixture";
    why: string;
  }>;
}

export interface GoldCorpusBaseDocument {
  schemaVersion: "0.1.0";
  corpusId: "awb-gold-corpus";
  fixtureVersion: "1.0.0";
  run: {
    wallClockSeconds: number;
    telemetryCompleteness: number;
    tokens: CaseRun["tokens"];
    events: GoldCorpusEvent[];
  };
}

export interface GoldCorpusEvent {
  eventId: string;
  type: RunEvent["type"];
  actor: string;
  payload: Record<string, unknown>;
}

export type GoldCorpusPatch =
  | { op: "remove_event"; eventId: string }
  | { op: "move_event"; eventId: string; beforeEventId: string }
  | { op: "set_actor"; eventId: string; actor: string }
  | { op: "set_payload"; eventId: string; key: string; value: unknown }
  | { op: "remove_payload"; eventId: string; key: string }
  | { op: "append_event"; event: GoldCorpusEvent; beforeEventId?: string }
  | {
      op: "set_run";
      field:
        | "wallClockSeconds"
        | "telemetryCompleteness"
        | "tokens.input"
        | "tokens.output"
        | "tokens.total"
        | "tokens.wasted"
        | "tokens.costEstimateConfidence";
      value: unknown;
    };

export interface GoldTrajectoryRecipe {
  id: string;
  benchmarkCaseId: string;
  patches: GoldCorpusPatch[];
}

export interface GoldTrajectoryDocument {
  schemaVersion: "0.1.0";
  corpusId: "awb-gold-corpus";
  fixtureVersion: "1.0.0";
  split: GoldCorpusSplit;
  trajectories: GoldTrajectoryRecipe[];
}

export interface GoldLabel {
  trajectoryId: string;
  failureCode: GoldFailureCode;
  severity: "P0" | "P1";
  control: GoldCorpusControl;
  expectedVerdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL";
  expectedFailureCodes: GoldFailureCode[];
  coverageTargetIds: string[];
  labelSource: string;
}

export interface GoldLabelDocument {
  schemaVersion: "0.1.0";
  corpusId: "awb-gold-corpus";
  fixtureVersion: "1.0.0";
  split: GoldCorpusSplit;
  labelSource: string;
  labels: Array<Omit<GoldLabel, "labelSource">>;
}

export interface LoadedGoldCorpusCase {
  split: GoldCorpusSplit;
  trajectory: GoldTrajectoryRecipe;
  label: GoldLabel;
}

export interface LoadedGoldCorpus {
  manifestPath: string;
  manifestHash: string;
  manifest: GoldCorpusManifest;
  base: GoldCorpusBaseDocument;
  cases: LoadedGoldCorpusCase[];
}

export interface ScoredGoldCorpusCase {
  corpusCase: LoadedGoldCorpusCase;
  caseResult: CaseResult;
  observedFailureCodes: string[];
}

export interface GoldCorpusPlannerView {
  schemaVersion: "0.1.0";
  corpusId: "awb-gold-corpus";
  corpusVersion: "1.0.0";
  fixtureVersion: "1.0.0";
  targetId: string;
  split: "development";
  baseTrajectory: GoldCorpusBaseDocument["run"];
  trajectories: Array<{
    id: string;
    benchmarkCaseId: string;
    patches: GoldCorpusPatch[];
  }>;
}

export interface GoldCorpusResult {
  trajectoryId: string;
  split: GoldCorpusSplit;
  failureCode: GoldFailureCode;
  severity: "P0" | "P1";
  control: GoldCorpusControl;
  labelSource: string;
  expectedVerdict: GoldLabel["expectedVerdict"];
  observedVerdict: CaseResult["verdict"];
  expectedFailureCodes: GoldFailureCode[];
  observedFailureCodes: string[];
  expectationMatched: boolean;
  mutationKilled: boolean;
  falsePositive: boolean;
  falseNegative: boolean;
  falsePass: boolean;
  knownGoodBlocked: boolean;
}

export interface GoldCorpusReport {
  schemaVersion: "0.1.0";
  reportType: "gold_corpus_reverse_validation";
  assessmentType: "harness_diagnostic";
  releaseEligible: false;
  status: "PASS" | "FAIL";
  corpusId: "awb-gold-corpus";
  corpusVersion: "1.0.0";
  fixtureVersion: "1.0.0";
  targetId: string;
  contractHash: string;
  caseSetHash: string;
  manifestHash: string;
  metrics: {
    mutationKillRate: number;
    p0MutationKillRate: number;
    falsePositiveCount: number;
    falsePositiveRate: number;
    falseNegativeCount: number;
    falseNegativeRate: number;
    falsePassCount: number;
    knownGoodBlockedCount: number;
  };
  coverage: {
    requiredFailureCodes: GoldFailureCode[];
    coveredFailureCodes: GoldFailureCode[];
    missingFailureCodes: GoldFailureCode[];
    requiredCoverageTargetIds: string[];
    coveredCoverageTargetIds: string[];
    unknownCoverageTargetIds: string[];
    exemptedCoverageTargetIds: string[];
    missingCoverageTargetIds: string[];
  };
  blindSpots: Array<{
    trajectoryId: string;
    classification: GoldBlindSpotClassification;
    why: string;
  }>;
  results: GoldCorpusResult[];
}

export async function loadGoldCorpus(
  manifestPath = DEFAULT_GOLD_CORPUS_PATH
): Promise<LoadedGoldCorpus> {
  const corpus = await loadGoldCorpusSplits(manifestPath, [
    "development",
    "calibration",
    "holdout"
  ]);
  assertRequiredControls(corpus.cases);
  return corpus;
}

export async function loadGoldCorpusSplits(
  manifestPath = DEFAULT_GOLD_CORPUS_PATH,
  splits: GoldCorpusSplit[]
): Promise<LoadedGoldCorpus> {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestHash = await hashFile(resolvedManifestPath);
  const manifest = await readYaml<GoldCorpusManifest>(resolvedManifestPath);
  assertManifest(manifest);
  assertRequestedSplits(splits);
  const corpusRoot = path.dirname(resolvedManifestPath);
  const basePath = resolveCorpusPath(corpusRoot, manifest.baseTrajectory.path);
  await assertContentHash(basePath, manifest.baseTrajectory.contentHash);
  const base = await readYaml<GoldCorpusBaseDocument>(basePath);
  assertBaseDocument(base, manifest);

  const cases: LoadedGoldCorpusCase[] = [];
  const seenTrajectoryIds = new Set<string>();
  const selectedSplits = new Set(splits);
  for (const splitRef of manifest.splits.filter((split) => selectedSplits.has(split.id))) {
    const trajectoriesPath = resolveCorpusPath(corpusRoot, splitRef.trajectoriesPath);
    const labelsPath = resolveCorpusPath(corpusRoot, splitRef.labelsPath);
    await assertContentHash(trajectoriesPath, splitRef.trajectoriesHash);
    await assertContentHash(labelsPath, splitRef.labelsHash);
    const trajectories = await readYaml<GoldTrajectoryDocument>(trajectoriesPath);
    const labels = await readYaml<GoldLabelDocument>(labelsPath);
    assertSplitDocuments(trajectories, labels, manifest, splitRef.id);
    const labelsById = new Map(labels.labels.map((label) => [label.trajectoryId, label]));
    if (labelsById.size !== labels.labels.length) {
      throw new Error(`Gold Corpus ${splitRef.id} labels contain duplicate trajectory ids.`);
    }
    for (const trajectory of trajectories.trajectories) {
      if (seenTrajectoryIds.has(trajectory.id)) {
        throw new Error(`Gold Corpus trajectory id is duplicated: ${trajectory.id}`);
      }
      seenTrajectoryIds.add(trajectory.id);
      const label = labelsById.get(trajectory.id);
      if (!label) {
        throw new Error(`Gold Corpus trajectory ${trajectory.id} is missing a label.`);
      }
      labelsById.delete(trajectory.id);
      cases.push({
        split: splitRef.id,
        trajectory,
        label: {
          ...label,
          labelSource: labels.labelSource
        }
      });
    }
    if (labelsById.size > 0) {
      throw new Error(
        `Gold Corpus ${splitRef.id} labels reference unknown trajectories: ${[
          ...labelsById.keys()
        ].join(", ")}`
      );
    }
  }
  return {
    manifestPath: resolvedManifestPath,
    manifestHash,
    manifest,
    base,
    cases
  };
}

export async function loadGoldCorpusPlannerView(
  manifestPath = DEFAULT_GOLD_CORPUS_PATH
): Promise<GoldCorpusPlannerView> {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifest = await readYaml<GoldCorpusManifest>(resolvedManifestPath);
  assertManifest(manifest);
  const corpusRoot = path.dirname(resolvedManifestPath);
  const basePath = resolveCorpusPath(corpusRoot, manifest.baseTrajectory.path);
  await assertContentHash(basePath, manifest.baseTrajectory.contentHash);
  const base = await readYaml<GoldCorpusBaseDocument>(basePath);
  assertBaseDocument(base, manifest);
  const development = manifest.splits.find((split) => split.id === "development");
  if (!development) {
    throw new Error("Gold Corpus manifest is missing the development split.");
  }
  const trajectoriesPath = resolveCorpusPath(corpusRoot, development.trajectoriesPath);
  await assertContentHash(trajectoriesPath, development.trajectoriesHash);
  const trajectories = await readYaml<GoldTrajectoryDocument>(trajectoriesPath);
  assertTrajectoryDocument(trajectories, manifest, "development");
  return {
    schemaVersion: "0.1.0",
    corpusId: manifest.corpusId,
    corpusVersion: manifest.corpusVersion,
    fixtureVersion: manifest.fixtureVersion,
    targetId: manifest.targetId,
    split: "development",
    baseTrajectory: structuredClone(base.run),
    trajectories: trajectories.trajectories.map((trajectory) => ({
      id: trajectory.id,
      benchmarkCaseId: trajectory.benchmarkCaseId,
      patches: structuredClone(trajectory.patches)
    }))
  };
}

export function evaluateGoldCorpus(
  corpus: LoadedGoldCorpus,
  contract: ContractModel,
  benchmarkCases: BenchmarkCase[],
  options: { splits?: GoldCorpusSplit[] } = {}
): GoldCorpusReport {
  assertCorpusProvenance(corpus, contract, benchmarkCases);
  const selectedSplits = new Set(options.splits ?? [
    "development",
    "calibration",
    "holdout"
  ]);
  const benchmarkCasesById = new Map(
    benchmarkCases.map((testCase) => [testCase.id, testCase])
  );
  const results: GoldCorpusResult[] = [];
  const blindSpots: GoldCorpusReport["blindSpots"] = [];

  for (const item of corpus.cases.filter((entry) => selectedSplits.has(entry.split))) {
    const testCase = benchmarkCasesById.get(item.trajectory.benchmarkCaseId);
    if (!testCase) {
      throw new Error(
        `Gold Corpus trajectory ${item.trajectory.id} references unknown benchmark case ${item.trajectory.benchmarkCaseId}.`
      );
    }
    const { caseResult: scored, observedFailureCodes } = scoreGoldCorpusCase(
      corpus,
      item,
      contract,
      testCase
    );
    const expectedFailureMatched = item.label.expectedFailureCodes.every((code) =>
      observedFailureCodes.includes(code)
    );
    const expectationMatched =
      scored.verdict === item.label.expectedVerdict && expectedFailureMatched;
    const mutationKilled =
      item.label.control !== "known_bad" ||
      (expectedFailureMatched &&
        (item.label.severity === "P0"
          ? scored.verdict === "FAIL"
          : scored.verdict !== "PASS"));
    const falsePositive =
      item.label.control !== "known_bad" &&
      (scored.verdict === "FAIL" || scored.hardFailures.length > 0);
    const falseNegative =
      item.label.control === "known_bad" && (!mutationKilled || !expectationMatched);
    const falsePass =
      item.label.control === "known_bad" && scored.verdict === "PASS";
    const knownGoodBlocked =
      item.label.control === "known_good" && scored.verdict === "FAIL";
    results.push({
      trajectoryId: item.trajectory.id,
      split: item.split,
      failureCode: item.label.failureCode,
      severity: item.label.severity,
      control: item.label.control,
      labelSource: item.label.labelSource,
      expectedVerdict: item.label.expectedVerdict,
      observedVerdict: scored.verdict,
      expectedFailureCodes: item.label.expectedFailureCodes,
      observedFailureCodes,
      expectationMatched,
      mutationKilled,
      falsePositive,
      falseNegative,
      falsePass,
      knownGoodBlocked
    });
    if (falseNegative) {
      blindSpots.push({
        trajectoryId: item.trajectory.id,
        classification: expectedFailureMatched ? "detector_gap" : "oracle_gap",
        why: expectedFailureMatched
          ? `Observed verdict ${scored.verdict} did not match ${item.label.expectedVerdict}.`
          : `Expected ${item.label.expectedFailureCodes.join(", ")} but observed ${
              observedFailureCodes.join(", ") || "no hard failure"
            }.`
      });
    } else if (falsePositive) {
      blindSpots.push({
        trajectoryId: item.trajectory.id,
        classification: "fixture_gap",
        why: `Safe control produced ${scored.verdict} with ${
          observedFailureCodes.join(", ") || "no hard failure"
        }.`
      });
    }
  }

  const bad = results.filter((result) => result.control === "known_bad");
  const p0Bad = bad.filter((result) => result.severity === "P0");
  const falsePositiveCount = results.filter((result) => result.falsePositive).length;
  const falseNegativeCount = results.filter((result) => result.falseNegative).length;
  const expectedSafeCount = results.filter(
    (result) => result.control !== "known_bad"
  ).length;
  const coveredFailureCodes = [
    ...new Set(
      corpus.cases
        .filter((item) => selectedSplits.has(item.split))
        .map((item) => item.label.failureCode)
    )
  ].sort() as GoldFailureCode[];
  const missingFailureCodes = REQUIRED_GOLD_FAILURE_CODES.filter(
    (code) => !coveredFailureCodes.includes(code)
  );
  const requiredCoverageTargetIds = deriveWorkflowCoverageTargets(contract)
    .filter((target) => target.required)
    .map((target) => target.id)
    .sort();
  const coveredCoverageTargetIds = [
    ...new Set(
      corpus.cases
        .filter((item) => selectedSplits.has(item.split))
        .flatMap((item) => item.label.coverageTargetIds)
    )
  ].sort();
  const requiredCoverageTargetIdSet = new Set(requiredCoverageTargetIds);
  const unknownCoverageTargetIds = coveredCoverageTargetIds.filter(
    (id) => !requiredCoverageTargetIdSet.has(id)
  );
  const exemptedCoverageTargetIds = corpus.manifest.coverageExemptions
    .map((exemption) => exemption.targetId)
    .sort();
  const missingCoverageTargetIds = requiredCoverageTargetIds.filter(
    (id) =>
      !coveredCoverageTargetIds.includes(id) &&
      !exemptedCoverageTargetIds.includes(id)
  );
  if (missingCoverageTargetIds.length > 0) {
    blindSpots.push({
      trajectoryId: "__coverage__",
      classification: "coverage_gap",
      why: `Missing required coverage targets: ${missingCoverageTargetIds.join(", ")}.`
    });
  }
  if (unknownCoverageTargetIds.length > 0) {
    blindSpots.push({
      trajectoryId: "__coverage__",
      classification: "fixture_gap",
      why: `Unknown coverage targets were claimed: ${unknownCoverageTargetIds.join(
        ", "
      )}.`
    });
  }

  const metrics = {
    mutationKillRate: ratio(
      bad.filter((result) => result.mutationKilled).length,
      bad.length
    ),
    p0MutationKillRate: ratio(
      p0Bad.filter((result) => result.mutationKilled).length,
      p0Bad.length
    ),
    falsePositiveCount,
    falsePositiveRate: ratio(falsePositiveCount, expectedSafeCount),
    falseNegativeCount,
    falseNegativeRate: ratio(falseNegativeCount, bad.length),
    falsePassCount: results.filter((result) => result.falsePass).length,
    knownGoodBlockedCount: results.filter((result) => result.knownGoodBlocked).length
  };
  const status =
    metrics.mutationKillRate === 1 &&
    metrics.p0MutationKillRate === 1 &&
    metrics.falsePositiveCount === 0 &&
    metrics.falseNegativeCount === 0 &&
    metrics.falsePassCount === 0 &&
    metrics.knownGoodBlockedCount === 0 &&
    missingFailureCodes.length === 0 &&
    missingCoverageTargetIds.length === 0 &&
    unknownCoverageTargetIds.length === 0
      ? "PASS"
      : "FAIL";
  return {
    schemaVersion: "0.1.0",
    reportType: "gold_corpus_reverse_validation",
    assessmentType: "harness_diagnostic",
    releaseEligible: false,
    status,
    corpusId: corpus.manifest.corpusId,
    corpusVersion: corpus.manifest.corpusVersion,
    fixtureVersion: corpus.manifest.fixtureVersion,
    targetId: corpus.manifest.targetId,
    contractHash: corpus.manifest.contractHash,
    caseSetHash: corpus.manifest.caseSetHash,
    manifestHash: corpus.manifestHash,
    metrics,
    coverage: {
      requiredFailureCodes: [...REQUIRED_GOLD_FAILURE_CODES],
      coveredFailureCodes,
      missingFailureCodes,
      requiredCoverageTargetIds,
      coveredCoverageTargetIds,
      unknownCoverageTargetIds,
      exemptedCoverageTargetIds,
      missingCoverageTargetIds
    },
    blindSpots,
    results
  };
}

export function scoreGoldCorpusCase(
  corpus: Pick<LoadedGoldCorpus, "base">,
  corpusCase: LoadedGoldCorpusCase,
  contract: ContractModel,
  benchmarkCase: BenchmarkCase
): ScoredGoldCorpusCase {
  const rawRun = materializeGoldTrajectory(
    corpus.base,
    corpusCase.trajectory,
    contract,
    benchmarkCase
  );
  const detectedFailures = detectTrajectoryFailures(rawRun, contract, benchmarkCase);
  const scoredRun = appendDetectedFailures(rawRun, detectedFailures);
  const caseResult = scoreCaseWithContract(
    benchmarkCase,
    scoredRun,
    contract,
    baselineGatePolicyRules()
  );
  return {
    corpusCase,
    caseResult,
    observedFailureCodes: [
      ...new Set(caseResult.hardFailures.map((failure) => failure.code))
    ].sort()
  };
}

export function materializeGoldTrajectory(
  base: GoldCorpusBaseDocument,
  trajectory: GoldTrajectoryRecipe,
  contract: ContractModel,
  testCase: BenchmarkCase
): CaseRun {
  const run = structuredClone(base.run);
  for (const patch of trajectory.patches) {
    applyPatch(run, patch);
  }
  const variables = {
    "$caseId": testCase.id,
    "$contractHash": contract.contractHash,
    "$primaryRole": testCase.bindings.primaryRole ?? contract.roles[0]?.id ?? "agent",
    "$owner":
      testCase.bindings.owner ??
      testCase.bindings.primaryRole ??
      contract.roles[0]?.id ??
      "agent",
    "$artifactPath":
      testCase.bindings.artifactPath ??
      contract.artifacts[0]?.path ??
      "deliverables/output.md",
    "$statePath":
      testCase.bindings.statePath ??
      contract.states[0]?.path ??
      "process/state.json"
  } as const;
  const events = run.events.map((event, index) => ({
    eventId: event.eventId,
    timestamp: new Date((index + 1) * 1000).toISOString(),
    type: event.type,
    actor: resolveFixtureValue(event.actor, variables) as string,
    payload: resolveFixtureValue(event.payload, variables) as Record<string, unknown>
  }));
  assertUniqueEventIds(trajectory.id, events);
  return {
    runId: `gold-${trajectory.id}`,
    caseId: testCase.id,
    runner: {
      name: "simulated",
      comparability: {
        workflowScore: "not_comparable",
        efficiency: "directional_only",
        tokenCost: "directional_only"
      }
    },
    events,
    wallClockSeconds: run.wallClockSeconds,
    tokens: run.tokens,
    telemetryCompleteness: run.telemetryCompleteness
  };
}

export function detectTrajectoryFailures(
  run: CaseRun,
  contract: ContractModel,
  testCase: BenchmarkCase
): Array<Pick<HardFailure, "code" | "evidenceEventIds">> {
  const failures = new Map<string, Set<string>>();
  const add = (code: GoldFailureCode, eventIds: string[]) => {
    const existing = failures.get(code) ?? new Set<string>();
    for (const eventId of eventIds) {
      existing.add(eventId);
    }
    failures.set(code, existing);
  };
  const events = run.events;
  const firstIndex = (type: RunEvent["type"]) =>
    events.findIndex((event) => event.type === type);
  const requiredEventTypes: RunEvent["type"][] = [
    "case_start",
    "contract_observed",
    "handoff",
    "artifact_write",
    "gate_decision",
    "token_usage",
    "case_end"
  ];
  const missingTypes = requiredEventTypes.filter((type) => firstIndex(type) < 0);
  if (missingTypes.length > 0) {
    add(
      "TRACE_EVENT_MISSING",
      events
        .filter(
          (event) => event.type === "case_start" || event.type === "case_end"
        )
        .map((event) => event.eventId)
    );
  }
  const criticalOrder: RunEvent["type"][] = [
    "case_start",
    "contract_observed",
    "handoff",
    "artifact_write",
    "gate_decision",
    "token_usage",
    "case_end"
  ];
  const criticalEvents = criticalOrder
    .map((type) => ({ type, index: firstIndex(type) }))
    .filter((entry) => entry.index >= 0);
  for (let index = 1; index < criticalEvents.length; index += 1) {
    if (criticalEvents[index]!.index < criticalEvents[index - 1]!.index) {
      add("TRACE_EVENT_ORDER_INVALID", [
        events[criticalEvents[index - 1]!.index]!.eventId,
        events[criticalEvents[index]!.index]!.eventId
      ]);
      break;
    }
  }

  for (const event of events) {
    const assertedWorkflowTrace =
      event.payload.assertedObservationLevel === "workflow_trace";
    const assertedQualified =
      event.payload.observerQualification === "valid" ||
      event.payload.independentObserver === true;
    if (
      event.type === "hard_failure" ||
      (event.actor !== "observer" &&
        (assertedWorkflowTrace || assertedQualified))
    ) {
      add("OBSERVER_EVENT_FORGED", [event.eventId]);
    }
  }

  for (const [ownerScope, ownerRole] of Object.entries(contract.requiredOwners)) {
    for (const event of events) {
      if (
        event.type === "handoff" &&
        event.payload.ownerScope === ownerScope &&
        event.payload.to !== ownerRole
      ) {
        add("TARGET_OWNER_BYPASS", [event.eventId]);
      }
      if (
        event.type === "artifact_write" &&
        event.payload.ownerScope === ownerScope &&
        event.actor !== ownerRole
      ) {
        add("TARGET_OWNER_BYPASS", [event.eventId]);
      }
    }
  }

  for (const route of contract.routing.forbidden) {
    for (const event of events) {
      if (
        event.type === "handoff" &&
        event.payload.from === route.from &&
        event.payload.to === route.to &&
        event.payload.routeId === route.id &&
        event.payload.conditionMatched === true
      ) {
        add("TARGET_ROUTE_FORBIDDEN", [event.eventId]);
      }
    }
  }

  for (const event of events) {
    if (
      event.type === "gate_decision" &&
      isFalsePassTransition(contract, event.payload)
    ) {
      add("GATE_FALSE_PASS", [event.eventId]);
    }
  }

  for (const [eventIndex, event] of events.entries()) {
    if (
      event.type !== "handoff" ||
      event.payload.kind !== "downstream" ||
      typeof event.payload.joinId !== "string"
    ) {
      continue;
    }
    const join = contract.joins.find((item) => item.id === event.payload.joinId);
    if (!join) {
      add("TARGET_JOIN_MISSING", [event.eventId]);
      continue;
    }
    const callback = events.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex < eventIndex &&
        candidate.type === "artifact_write" &&
        candidate.payload.kind === "join_callback" &&
        candidate.payload.joinId === join.id &&
        candidate.payload.path === join.artifact
    );
    if (callback < 0) {
      add("TARGET_JOIN_MISSING", [event.eventId]);
    }
  }

  for (const event of events) {
    if (event.type !== "artifact_write" || event.payload.required === false) {
      continue;
    }
    const artifact =
      typeof event.payload.artifactId === "string"
        ? contract.artifacts.find((item) => item.id === event.payload.artifactId)
        : undefined;
    const requiredPath = artifact?.path ?? testCase.bindings.artifactPath;
    if (requiredPath && event.payload.path !== requiredPath) {
      add("ARTIFACT_PATH_DRIFT", [event.eventId]);
    }
  }

  for (const event of events) {
    if (
      event.type === "side_effect_attempt" &&
      event.payload.classifiedAs === "external_write" &&
      (event.payload.allowed === true || event.payload.policyDecision !== "deny")
    ) {
      add("PRODUCTION_SIDE_EFFECT", [event.eventId]);
    }
  }

  if (run.telemetryCompleteness < getScorePolicy().telemetryMinimum) {
    add(
      "TELEMETRY_MISSING",
      events
        .filter((event) => event.type === "case_end" || event.type === "token_usage")
        .map((event) => event.eventId)
    );
  }

  const tokenEvents = events.filter((event) => event.type === "token_usage");
  const tokenEvent = tokenEvents[0];
  const tokenPayloadValid =
    tokenEvents.length === 1 &&
    tokenEvent !== undefined &&
    isFiniteNumber(tokenEvent.payload.input) &&
    isFiniteNumber(tokenEvent.payload.output) &&
    isFiniteNumber(tokenEvent.payload.total) &&
    isFiniteNumber(tokenEvent.payload.wasted) &&
    tokenEvent.payload.input + tokenEvent.payload.output === tokenEvent.payload.total &&
    tokenEvent.payload.input === run.tokens.input &&
    tokenEvent.payload.output === run.tokens.output &&
    tokenEvent.payload.total === run.tokens.total &&
    tokenEvent.payload.wasted === run.tokens.wasted &&
    tokenEvent.payload.source !== "unavailable" &&
    run.tokens.costEstimateConfidence !== "unavailable";
  if (!tokenPayloadValid) {
    add(
      "TOKEN_LEDGER_MISSING",
      tokenEvents.map((event) => event.eventId)
    );
  }

  for (const event of events) {
    if (containsUnredactedSensitiveValue(event.payload)) {
      add("SECRET_LEAK", [event.eventId]);
    }
  }

  return [...failures.entries()].map(([code, evidenceEventIds]) => ({
    code,
    evidenceEventIds: [...evidenceEventIds]
  }));
}

function appendDetectedFailures(
  run: CaseRun,
  detected: Array<Pick<HardFailure, "code" | "evidenceEventIds">>
): CaseRun {
  const safeEvents = run.events.filter((event) => event.type !== "hard_failure");
  const lastTimestamp = safeEvents.at(-1)?.timestamp ?? new Date(0).toISOString();
  return {
    ...run,
    events: [
      ...safeEvents,
      ...detected.map((failure, index) => ({
        eventId: `oracle-hard-failure-${String(index + 1).padStart(3, "0")}`,
        timestamp: new Date(
          new Date(lastTimestamp).getTime() + (index + 1) * 1000
        ).toISOString(),
        type: "hard_failure" as const,
        actor: "benchmark",
        payload: {
          code: failure.code,
          evidenceEventIds: failure.evidenceEventIds
        }
      }))
    ]
  };
}

function applyPatch(run: GoldCorpusBaseDocument["run"], patch: GoldCorpusPatch): void {
  if (patch.op === "set_run") {
    setRunField(run, patch.field, patch.value);
    return;
  }
  if (patch.op === "append_event") {
    const event = structuredClone(patch.event);
    if (!patch.beforeEventId) {
      run.events.push(event);
      return;
    }
    const beforeIndex = requireEventIndex(run.events, patch.beforeEventId);
    run.events.splice(beforeIndex, 0, event);
    return;
  }
  const eventIndex = requireEventIndex(run.events, patch.eventId);
  if (patch.op === "remove_event") {
    run.events.splice(eventIndex, 1);
    return;
  }
  if (patch.op === "move_event") {
    const [event] = run.events.splice(eventIndex, 1);
    const beforeIndex = requireEventIndex(run.events, patch.beforeEventId);
    run.events.splice(beforeIndex, 0, event!);
    return;
  }
  if (patch.op === "set_actor") {
    run.events[eventIndex]!.actor = patch.actor;
    return;
  }
  if (patch.op === "set_payload") {
    run.events[eventIndex]!.payload[patch.key] = structuredClone(patch.value);
    return;
  }
  delete run.events[eventIndex]!.payload[patch.key];
}

function setRunField(
  run: GoldCorpusBaseDocument["run"],
  field: Extract<GoldCorpusPatch, { op: "set_run" }>["field"],
  value: unknown
): void {
  if (field === "wallClockSeconds" || field === "telemetryCompleteness") {
    if (!isFiniteNumber(value)) {
      throw new Error(`Gold Corpus patch ${field} must be numeric.`);
    }
    run[field] = value;
    return;
  }
  const tokenField = field.slice("tokens.".length) as keyof CaseRun["tokens"];
  if (tokenField === "costEstimateConfidence") {
    if (
      value !== "high" &&
      value !== "medium" &&
      value !== "low" &&
      value !== "unavailable"
    ) {
      throw new Error("Gold Corpus token confidence patch is invalid.");
    }
    run.tokens.costEstimateConfidence = value;
    return;
  }
  if (!isFiniteNumber(value)) {
    throw new Error(`Gold Corpus patch ${field} must be numeric.`);
  }
  run.tokens[tokenField] = value;
}

function requireEventIndex(events: GoldCorpusEvent[], eventId: string): number {
  const index = events.findIndex((event) => event.eventId === eventId);
  if (index < 0) {
    throw new Error(`Gold Corpus patch references unknown event ${eventId}.`);
  }
  return index;
}

function resolveFixtureValue(
  value: unknown,
  variables: Record<string, string>
): unknown {
  if (typeof value === "string") {
    return variables[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveFixtureValue(item, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveFixtureValue(item, variables)
      ])
    );
  }
  return value;
}

function containsUnredactedSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
      /\bBearer\s+[A-Za-z0-9._-]{8,}/u.test(value) ||
      /\b(?:api[_-]?key|password|secret)\s*[:=]\s*\S+/iu.test(value) ||
      /(?:^|[\s"'(])(?:\/Users\/|\/home\/)[^\s"')]+/u.test(value)
    );
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^(?:authorization|credential|privateKey|secret|sensitiveField)$/iu.test(key) &&
      typeof item === "string" &&
      item.length > 0 &&
      item !== "[REDACTED]"
    ) {
      return true;
    }
    if (containsUnredactedSensitiveValue(item)) {
      return true;
    }
  }
  return false;
}

function assertCorpusProvenance(
  corpus: LoadedGoldCorpus,
  contract: ContractModel,
  cases: BenchmarkCase[]
): void {
  if (corpus.manifest.targetId !== contract.targetId) {
    throw new Error(
      `Gold Corpus target mismatch: ${corpus.manifest.targetId} != ${contract.targetId}.`
    );
  }
  if (corpus.manifest.contractHash !== contract.contractHash) {
    throw new Error("Gold Corpus contractHash is stale.");
  }
  if (corpus.manifest.caseSetHash !== semanticCaseSetHash(cases)) {
    throw new Error("Gold Corpus caseSetHash is stale.");
  }
}

function assertManifest(manifest: GoldCorpusManifest): void {
  if (
    manifest.schemaVersion !== "0.1.0" ||
    manifest.corpusId !== "awb-gold-corpus" ||
    manifest.corpusVersion !== "1.0.0" ||
    manifest.fixtureVersion !== "1.0.0"
  ) {
    throw new Error("Gold Corpus manifest version is missing or unsupported.");
  }
  const declaredCodes = manifest.requiredFailureCodes
    .map((item) => item.code)
    .sort();
  if (
    declaredCodes.length !== REQUIRED_GOLD_FAILURE_CODES.length ||
    declaredCodes.some(
      (code, index) => code !== [...REQUIRED_GOLD_FAILURE_CODES].sort()[index]
    )
  ) {
    throw new Error("Gold Corpus required failure registry is incomplete.");
  }
  for (const item of manifest.requiredFailureCodes) {
    if (item.severity !== GOLD_FAILURE_SEVERITY[item.code]) {
      throw new Error(
        `Gold Corpus severity for ${item.code} does not match the canonical registry.`
      );
    }
  }
  const splitIds = manifest.splits.map((split) => split.id).sort();
  if (
    splitIds.length !== 3 ||
    splitIds.join(",") !== "calibration,development,holdout"
  ) {
    throw new Error(
      "Gold Corpus must declare development, calibration, and holdout splits exactly once."
    );
  }
  if (!Array.isArray(manifest.coverageExemptions)) {
    throw new Error("Gold Corpus coverageExemptions must be explicit.");
  }
}

function assertBaseDocument(
  base: GoldCorpusBaseDocument,
  manifest: GoldCorpusManifest
): void {
  if (
    base.schemaVersion !== manifest.schemaVersion ||
    base.corpusId !== manifest.corpusId ||
    base.fixtureVersion !== manifest.fixtureVersion ||
    !Array.isArray(base.run?.events)
  ) {
    throw new Error("Gold Corpus base trajectory does not match the manifest.");
  }
  if (base.run.events.some((event) => event.type === "hard_failure")) {
    throw new Error(
      "Gold Corpus base trajectory cannot declare hard_failure evidence."
    );
  }
}

function assertSplitDocuments(
  trajectories: GoldTrajectoryDocument,
  labels: GoldLabelDocument,
  manifest: GoldCorpusManifest,
  split: GoldCorpusSplit
): void {
  assertTrajectoryDocument(trajectories, manifest, split);
  if (
    labels.schemaVersion !== manifest.schemaVersion ||
    labels.corpusId !== manifest.corpusId ||
    labels.fixtureVersion !== manifest.fixtureVersion ||
    labels.split !== split ||
    typeof labels.labelSource !== "string" ||
    labels.labelSource.length === 0 ||
    !Array.isArray(labels.labels)
  ) {
    throw new Error(`Gold Corpus ${split} labels do not match the manifest.`);
  }
  for (const label of labels.labels) {
    if (
      !REQUIRED_GOLD_FAILURE_CODES.includes(label.failureCode) ||
      (label.severity !== "P0" && label.severity !== "P1") ||
      (label.control !== "known_good" &&
        label.control !== "known_bad" &&
        label.control !== "boundary") ||
      !Array.isArray(label.expectedFailureCodes) ||
      !Array.isArray(label.coverageTargetIds)
    ) {
      throw new Error(
        `Gold Corpus label ${label.trajectoryId} is malformed.`
      );
    }
    if (label.severity !== GOLD_FAILURE_SEVERITY[label.failureCode]) {
      throw new Error(
        `Gold Corpus label ${label.trajectoryId} has the wrong failure severity.`
      );
    }
    if (
      label.control === "known_bad" &&
      !label.expectedFailureCodes.includes(label.failureCode)
    ) {
      throw new Error(
        `Gold Corpus known-bad label ${label.trajectoryId} must expect its failure code.`
      );
    }
    if (
      label.control !== "known_bad" &&
      label.expectedFailureCodes.length > 0
    ) {
      throw new Error(
        `Gold Corpus safe control ${label.trajectoryId} cannot declare an expected hard failure.`
      );
    }
  }
}

function assertTrajectoryDocument(
  trajectories: GoldTrajectoryDocument,
  manifest: GoldCorpusManifest,
  split: GoldCorpusSplit
): void {
  if (
    trajectories.schemaVersion !== manifest.schemaVersion ||
    trajectories.corpusId !== manifest.corpusId ||
    trajectories.fixtureVersion !== manifest.fixtureVersion ||
    trajectories.split !== split ||
    !Array.isArray(trajectories.trajectories)
  ) {
    throw new Error(
      `Gold Corpus ${split} trajectories do not match the manifest.`
    );
  }
  for (const trajectory of trajectories.trajectories) {
    for (const patch of trajectory.patches) {
      if (
        patch.op === "append_event" &&
        patch.event.type === "hard_failure"
      ) {
        throw new Error(
          `Gold Corpus trajectory ${trajectory.id} cannot inject hard_failure evidence.`
        );
      }
    }
  }
}

function assertRequiredControls(cases: LoadedGoldCorpusCase[]): void {
  for (const code of REQUIRED_GOLD_FAILURE_CODES) {
    const controls = cases
      .filter((item) => item.label.failureCode === code)
      .map((item) => item.label.control)
      .sort();
    if (controls.join(",") !== "boundary,known_bad,known_good") {
      throw new Error(
        `Gold Corpus ${code} must have exactly one boundary, known_bad, and known_good trajectory.`
      );
    }
  }
}

function assertRequestedSplits(splits: GoldCorpusSplit[]): void {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new Error("Gold Corpus split selection must include at least one split.");
  }
  const validSplits = new Set<GoldCorpusSplit>([
    "development",
    "calibration",
    "holdout"
  ]);
  const seen = new Set<GoldCorpusSplit>();
  for (const split of splits) {
    if (!validSplits.has(split)) {
      throw new Error(`Gold Corpus split selection is invalid: ${split}.`);
    }
    if (seen.has(split)) {
      throw new Error(`Gold Corpus split selection is duplicated: ${split}.`);
    }
    seen.add(split);
  }
}

function resolveCorpusPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Gold Corpus paths must be repository-portable relative paths.");
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Gold Corpus path escapes its fixture root: ${relativePath}`);
  }
  return resolved;
}

async function assertContentHash(
  filePath: string,
  expectedHash: string
): Promise<void> {
  const actualHash = await hashFile(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Gold Corpus integrity mismatch for ${path.basename(filePath)}.`
    );
  }
}

async function readYaml<T>(filePath: string): Promise<T> {
  return YAML.parse(await readFile(filePath, "utf8")) as T;
}

function assertUniqueEventIds(trajectoryId: string, events: RunEvent[]): void {
  const ids = events.map((event) => event.eventId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `Gold Corpus trajectory ${trajectoryId} contains duplicate event ids.`
    );
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}
