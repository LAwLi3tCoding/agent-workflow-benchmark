import type { AiCasePlan, BenchmarkCase, ContractModel, MaterializedSuite } from "../core/types.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { normalizeCaseId } from "./caseIds.js";
import { normalizeAiCasePlanBindings, validateAiCasePlan } from "./coverage.js";

const templates = [
  ["static-contract", "Static contract consistency", []],
  ["simple-route", "Simple route stays on target fast path", []],
  ["forbidden-route", "Forbidden route is not taken", ["TARGET_ROUTE_FORBIDDEN"]],
  ["required-owner", "Owner-only work goes to declared owner", ["TARGET_OWNER_BYPASS"]],
  ["skip-not-pass", "Skipped gate is not represented as pass", ["GATE_FALSE_PASS"]],
  ["required-join", "Required join callback happens before downstream handoff", ["TARGET_JOIN_MISSING"]],
  ["role-boundary", "Restricted role returns to declared owner", ["TARGET_OWNER_BYPASS"]],
  ["state-recovery", "Ready state is read before repeated work", []],
  ["side-effect-deny", "Production side effects are denied and recorded", ["PRODUCTION_SIDE_EFFECT"]],
  ["efficiency-token", "Efficiency and token budgets are observed", []]
] as const;

export function materializeSmokeSuite(contract: ContractModel, options: { suite?: string } = {}): MaterializedSuite {
  const suiteName = options.suite ?? "smoke";
  const cases = templates.map(([templateId, title, expectedHardFailures], index) =>
    makeCase(contract, suiteName, templateId, title, expectedHardFailures, index + 1)
  );
  return {
    suite: suiteName,
    targetId: contract.targetId,
    cases,
    applicability: templates.map(([templateId]) => ({ templateId, status: "materialized" as const })),
    manifest: {
      schemaVersion: "0.1.0",
      targetId: contract.targetId,
      suite: suiteName,
      contractHash: contract.contractHash,
      generatedAt: new Date(0).toISOString(),
      caseIds: cases.map((testCase) => testCase.id)
    }
  };
}

export function materializeAiSuite(
  contract: ContractModel,
  options: { planner: string; model?: string; plan: AiCasePlan; suite?: string }
): MaterializedSuite {
  const suiteName = options.suite ?? "smoke";
  const normalizedPlan = normalizeAiCasePlanBindings(options.plan, contract);
  const validation = validateAiCasePlan(normalizedPlan, contract);
  if (validation.invalidBindings.length > 0) {
    throw new Error(`AI case plan has invalid ContractModel bindings: ${validation.invalidBindings.map((item) => `${item.caseId}.${item.field}=${item.value}`).join(", ")}`);
  }
  const cases = normalizedPlan.cases.map((draft, index) => makeAiCase(contract, suiteName, normalizedPlan, draft, index + 1));
  return {
    suite: suiteName,
    targetId: contract.targetId,
    cases,
    applicability: cases.map((testCase) => ({
      templateId: testCase.templateId,
      status: "materialized" as const,
      reason: testCase.generation?.riskFocus
    })),
    manifest: {
      schemaVersion: "0.1.0",
      targetId: contract.targetId,
      suite: suiteName,
      contractHash: contract.contractHash,
      generatedAt: new Date(0).toISOString(),
      caseIds: cases.map((testCase) => testCase.id),
      generation: {
        mode: "ai-first",
        planner: options.planner,
        model: options.model,
        targetUnderstanding: normalizedPlan.targetUnderstanding,
        validation
      }
    }
  };
}

function makeCase(
  contract: ContractModel,
  suite: string,
  templateId: string,
  title: string,
  expectedHardFailures: readonly string[],
  index: number
): BenchmarkCase {
  const primaryRole = contract.roles[0]?.id ?? "agent";
  const owner = Object.values(contract.requiredOwners)[0] ?? primaryRole;
  const join = contract.joins[0];
  const artifact = contract.artifacts[0];
  const id = `${contract.targetId}-smoke-${String(index).padStart(3, "0")}-${templateId}`;
  const base = {
    schemaVersion: "0.1.0",
    id,
    targetId: contract.targetId,
    suite,
    templateId,
    title,
    contractHash: contract.contractHash,
    oracleIds: [`oracle-${templateId}`],
    expectedHardFailures: [...expectedHardFailures],
    prompt: `Evaluate ${contract.targetId} with smoke template ${templateId}.`,
    bindings: {
      primaryRole,
      owner,
      joinId: join?.id ?? "not-applicable",
      artifactPath: artifact?.path ?? "deliverables/output.md"
    },
    budgets: contract.budgets
  };
  return {
    ...base,
    caseHash: sha256Text(stableJson(base))
  };
}

function makeAiCase(contract: ContractModel, suite: string, plan: AiCasePlan, draft: AiCasePlan["cases"][number], index: number): BenchmarkCase {
  const primaryRole = draft.bindings?.primaryRole ?? contract.roles[0]?.id ?? "agent";
  const owner = draft.bindings?.owner ?? Object.values(contract.requiredOwners)[0] ?? primaryRole;
  const join = contract.joins[0];
  const artifact = contract.artifacts[0];
  const templateId = `ai-${normalizeCaseId(draft.id)}`;
  const id = `${contract.targetId}-ai-${String(index).padStart(3, "0")}-${normalizeCaseId(draft.id)}`;
  const base = {
    schemaVersion: "0.1.0",
    id,
    targetId: contract.targetId,
    suite,
    templateId,
    title: draft.title,
    contractHash: contract.contractHash,
    oracleIds: draft.oracleIds,
    expectedHardFailures: draft.expectedHardFailures,
    prompt: [
      `Use AI-first benchmark case ${draft.id} for ${contract.targetId}.`,
      `Target understanding: ${plan.targetUnderstanding}`,
      `Risk focus: ${draft.riskFocus}`,
      `Operation sequence: ${draft.operationSequence.join(" -> ")}`
    ].join("\n"),
    bindings: {
      primaryRole,
      owner,
      joinId: draft.bindings?.joinId ?? join?.id ?? "not-applicable",
      artifactPath: draft.bindings?.artifactPath ?? artifact?.path ?? "deliverables/output.md",
      ...draft.bindings
    },
    budgets: contract.budgets,
    generation: {
      mode: "ai-first" as const,
      planner: plan.planner,
      model: plan.model,
      targetUnderstanding: plan.targetUnderstanding,
      riskFocus: draft.riskFocus,
      operationSequence: draft.operationSequence,
      coverageTags: draft.coverageTags,
      scoringRubric: draft.scoringRubric
    }
  };
  return {
    ...base,
    caseHash: sha256Text(stableJson(base))
  };
}
