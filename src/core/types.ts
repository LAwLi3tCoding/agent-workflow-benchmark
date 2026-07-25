export type TargetType = "directory" | "cli" | "hybrid";

export interface TargetEntrypoint {
  id: string;
  kind: "file" | "cli";
  path?: string;
  command?: string;
}

export interface TargetRole {
  id: string;
  path: string;
  ownerScopes: string[];
}

export type TargetContractReview =
  | {
      status: "draft";
    }
  | {
      status: "reviewed";
      reviewerId: string;
      reviewedAt: string;
      artifactPath: string;
      artifactHash: string;
    };

export interface ContractValidityArtifact {
  schemaVersion: "0.1.0";
  artifactType: "contract-validity";
  targetId: string;
  contractHash: string;
  decision: "approved";
  reviewerId: string;
  reviewedAt: string;
  reviewedContractFields: string[];
}

export interface TargetPack {
  schemaVersion: string;
  id: string;
  name: string;
  targetType: TargetType;
  root: string;
  entrypoints: TargetEntrypoint[];
  roles: TargetRole[];
  contracts: {
    statuses: string[];
    requiredOwners: Record<string, string>;
    routing: {
      forbidden: Array<{ id: string; from: string; to: string; when: string }>;
    };
    joins: Array<{ id: string; producer: string; consumer: string; artifact: string }>;
    artifacts: Array<{ id: string; path: string; owner: string }>;
    states: Array<{ id: string; path: string }>;
    budgets: {
      wallClockSeconds: number;
      tokenTotal: number;
    };
  };
  commandPolicy: {
    allowedExecutables: string[];
    forbiddenArgs: string[];
  };
  contractReview: TargetContractReview;
  configPath: string;
}

export interface ProfileEvidence {
  targetId: string;
  root: string;
  scannedFiles: Array<{ path: string; sha256: string; bytes: number; excerpt?: string }>;
  missingFiles: string[];
  warnings: string[];
}

export interface ContractModel {
  schemaVersion: string;
  targetId: string;
  targetType: TargetType;
  root: string;
  contractHash: string;
  entrypoints: TargetEntrypoint[];
  roles: TargetRole[];
  statuses: string[];
  requiredOwners: Record<string, string>;
  routing: TargetPack["contracts"]["routing"];
  joins: TargetPack["contracts"]["joins"];
  artifacts: TargetPack["contracts"]["artifacts"];
  states: TargetPack["contracts"]["states"];
  budgets: TargetPack["contracts"]["budgets"];
  commandPolicy: TargetPack["commandPolicy"];
  evidenceRefs: string[];
}

export interface ProfileResult {
  evidence: ProfileEvidence;
  contract: ContractModel;
}

export interface BenchmarkCase {
  schemaVersion: string;
  id: string;
  targetId: string;
  suite: string;
  templateId: string;
  title: string;
  contractHash: string;
  caseHash: string;
  oracleIds: string[];
  expectedHardFailures: string[];
  prompt: string;
  bindings: Record<string, string>;
  budgets: {
    wallClockSeconds: number;
    tokenTotal: number;
  };
  generation?: {
    mode: "template" | "ai-first";
    planner: string;
    model?: string;
    targetUnderstanding?: string;
    riskFocus?: string;
    operationSequence?: string[];
    coverageTags?: string[];
    scoringRubric?: string[];
  };
}

export interface WorkflowCoverageTarget {
  id: string;
  category: "dimension" | "role" | "owner" | "join" | "route" | "artifact" | "state" | "status" | "policy";
  label: string;
  required: boolean;
}

export interface AiPlanValidation {
  schemaVersion: "0.1.0";
  coverageMode: CoverageMode;
  status: "PASS" | "WARN" | "FAIL";
  recommendedCaseCount: number;
  coverageTargetCount: number;
  coveredCoverageTargetIds: string[];
  missingCoverageTargetIds: string[];
  unknownCoverageTags: string[];
  invalidBindings: Array<{ caseId: string; field: string; value: string; why: string }>;
  warnings: string[];
}

export interface MaterializedSuite {
  suite: string;
  targetId: string;
  cases: BenchmarkCase[];
  applicability: Array<{
    templateId: string;
    status: "materialized" | "notApplicable";
    reason?: string;
  }>;
  manifest: {
    schemaVersion: string;
    targetId: string;
    suite: string;
    contractHash: string;
    generatedAt: string;
    seed: string;
    caseIds: string[];
    generation?: {
      mode: "template" | "ai-first";
      planner: string;
      model?: string;
      targetUnderstanding?: string;
      validation?: AiPlanValidation;
    };
  };
}

export interface AiCaseDraft {
  id: string;
  title: string;
  riskFocus: string;
  operationSequence: string[];
  oracleIds: string[];
  expectedHardFailures: string[];
  coverageTags?: string[];
  scoringRubric?: string[];
  bindings?: Record<string, string>;
}

export interface AiCasePlan {
  planner: string;
  model?: string;
  coverageMode?: CoverageMode;
  targetUnderstanding: string;
  workflowUnderstanding?: {
    goal: string;
    stages: string[];
    criticalInvariants: string[];
    scoringSignals: string[];
  };
  cases: AiCaseDraft[];
}

export type CoverageMode = "smoke" | "full" | "adaptive";

export interface RunEvent {
  eventId: string;
  timestamp: string;
  type:
    | "case_start"
    | "contract_observed"
    | "handoff"
    | "gate_decision"
    | "artifact_write"
    | "state_read"
    | "side_effect_attempt"
    | "token_usage"
    | "runner_start"
    | "runner_transcript"
    | "runner_result"
    | "runner_exit"
    | "filesystem_access"
    | "tool_call"
    | "process_spawn"
    | "network_access"
    | "hard_failure"
    | "case_end";
  actor: string;
  payload: Record<string, unknown>;
}

export interface CaseRun {
  runId: string;
  caseId: string;
  runner?: {
    name: RunnerCapability["name"];
    comparability: RunnerCapability["comparability"];
  };
  events: RunEvent[];
  wallClockSeconds: number;
  tokens: {
    input: number;
    output: number;
    total: number;
    wasted: number;
    costEstimateConfidence: "high" | "medium" | "low" | "unavailable";
  };
  telemetryCompleteness: number;
}

export interface RunnerCapability {
  schemaVersion: string;
  name: "codex" | "claude" | "opencode" | "simulated";
  supported: boolean;
  disabledReason?: string;
  executable?: string;
  version?: string;
  adapterVersion: string;
  executionMode: "live" | "simulated" | "disabled";
  supportsEntrypointKinds: Array<"file" | "cli">;
  tokenSourceDetail: {
    source: "native" | "estimated" | "unavailable";
    confidence: "high" | "medium" | "low" | "unavailable";
  };
  comparability: {
    workflowScore: "comparable" | "directional_only" | "not_comparable";
    efficiency: "comparable" | "directional_only" | "not_comparable";
    tokenCost: "comparable" | "directional_only" | "not_comparable";
  };
  capabilitiesHash: string;
}

export interface HardFailure {
  code: string;
  severity: "P0" | "P1";
  why: string;
  evidenceEventIds: string[];
}

export type EvaluationDimension =
  | "contract"
  | "routing"
  | "ownership"
  | "gate"
  | "artifact"
  | "state"
  | "join"
  | "sideEffect"
  | "telemetry"
  | "efficiency"
  | "runner";

export type EvaluationStatus = "PASS" | "WARN" | "FAIL" | "DIAGNOSTIC_ONLY";

export interface CaseEvaluationDimension {
  dimension: EvaluationDimension;
  rawPoints: number;
  maxPoints: number;
  score: number;
  status: EvaluationStatus;
  why: string;
  evidenceEventIds: string[];
  relatedFailureCodes: string[];
}

export interface SuiteDimensionScore {
  dimension: EvaluationDimension;
  rawPoints: number;
  maxPoints: number;
  score: number;
  status: EvaluationStatus;
  affectedCaseIds: string[];
  why: string;
}

export interface AgentWorkflowRecommendation {
  id: string;
  priority: "P0" | "P1" | "P2";
  category:
    | "routing"
    | "ownership"
    | "gate"
    | "artifact"
    | "state"
    | "join"
    | "side-effect"
    | "telemetry"
    | "efficiency"
    | "runner-evidence"
    | "contract";
  summary: string;
  suggestedChange: string;
  evidenceCaseIds: string[];
  sourceFailureCodes: string[];
  targetRoles: string[];
}

export interface HarnessValidation {
  schemaVersion: "0.1.0";
  status: "PASS" | "WARN" | "FAIL";
  plan: {
    status: AiPlanValidation["status"];
    recommendedCaseCount: number;
    coverageTargetCount: number;
    coveredCoverageTargetCount: number;
    missingCoverageTargetCount: number;
    unknownCoverageTagCount: number;
    invalidBindingCount: number;
    warnings: string[];
  };
  phases: Array<{
    phase: "profile" | "understand" | "plan" | "materialize" | "execute" | "score" | "recommend";
    status: "PASS" | "WARN" | "FAIL";
    why: string;
  }>;
}

export interface P0CaseRecord {
  schemaVersion: string;
  recordedAt: string;
  targetId: string;
  suite: string;
  runId: string;
  caseId: string;
  caseHash: string;
  contractHash: string;
  templateId: string;
  title: string;
  failureCode: string;
  severity: "P0";
  why: string;
  evidenceEventIds: string[];
  recommendedAction: string;
}

export interface CaseResult {
  schemaVersion: string;
  resultType: "case";
  targetId: string;
  caseId: string;
  caseHash: string;
  contractHash: string;
  templateId: string;
  title: string;
  runner: { name: string; comparability: Record<string, string> };
  score: number;
  rawScore: number;
  cappedScore: number;
  scoreCap: number;
  verdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "DIAGNOSTIC_ONLY";
  hardFailures: HardFailure[];
  telemetryCompleteness: number;
  tokens: CaseRun["tokens"];
  efficiency: { wallClockSeconds: number };
  evaluationDimensions: CaseEvaluationDimension[];
  scoreProvenance: {
    oracleResults: Array<{ oracleId: string; status: "PASS" | "FAIL"; why: string }>;
    dimensionProvenance: Array<{ dimension: string; rawPoints: number; maxPoints: number; status?: EvaluationStatus; why: string }>;
  };
}

export interface SuiteResult {
  schemaVersion: string;
  resultType: "suite";
  targetId: string;
  suite: string;
  runId: string;
  gatePolicy: import("../calibration/policyArtifact.js").GatePolicyBinding;
  caseResults: Array<{
    caseId: string;
    verdict: CaseResult["verdict"];
    rawScore: number;
    cappedScore: number;
    hardFailures: HardFailure[];
  }>;
  dimensionScores: SuiteDimensionScore[];
  recommendations: AgentWorkflowRecommendation[];
  p0CaseRecords: P0CaseRecord[];
  rawSuiteScore: number;
  cappedSuiteScore: number;
  releaseDecision: "APPROVE" | "CONDITIONAL_APPROVE" | "BLOCK" | "DIAGNOSTIC_ONLY";
  releaseRuleId: string;
  telemetryCompleteness: number;
  debugHealth: {
    status: "NOT_RUN" | "PASS" | "FAIL";
    mutationKillRate: number | null;
    falseNegativeCount: number | null;
    falsePositiveCount: number | null;
    environmentReproducibility: number | null;
    lastReverseValidationRunId: string | null;
    doesNotAffectTargetScore: true;
  };
  harnessValidation?: HarnessValidation;
}

export interface MutationInput {
  id: string;
  type: string;
  scope?: "overlay-only";
  expectedVerdict?: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "DIAGNOSTIC_ONLY";
  expectedHardFailureCode?: string;
}

export interface DebugEnvironment {
  schemaVersion: string;
  debugId: string;
  targetId: string;
  caseId: string;
  contractHash: string;
  caseHash: string;
  sandboxRoot: string;
  mockProfile: string;
  fakeTools: Array<{ name: string; path: string; behaviorFixture: string }>;
  mockServices: Array<{ id: string; kind: string; baseUrl: string; fixture: string }>;
  fixtureRepos: Array<{ id: string; source: string; sandboxPath: string; sourceHash: string }>;
  stateSeeds: string[];
  artifactSeeds: string[];
  networkPolicyHash: string;
  commandPolicyHash: string;
  reproduceCommands: string[];
  preflightResults: Array<{ status: "PASS" | "FAIL" | "DIAGNOSTIC_ONLY"; check: string; why: string }>;
}

export interface ReverseValidationResult {
  schemaVersion: string;
  debugId: string;
  status: "PASS" | "FAIL";
  mutationId: string;
  runner: "simulated";
  mutationScope: "overlay-only";
  expectedVerdict?: MutationInput["expectedVerdict"];
  expectationMatched: boolean;
  expectedHardFailureCode?: string;
  expectedHardFailureMatched?: boolean;
  baseline: CaseResult;
  mutant: CaseResult;
  restore: CaseResult;
  mutationKilled: boolean;
  falseNegative: boolean;
  falsePositive: boolean;
  debugDossierPath?: string;
}
