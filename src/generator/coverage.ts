import type { AiCasePlan, AiPlanValidation, ContractModel, CoverageMode, WorkflowCoverageTarget } from "../core/types.js";
import { getImplementedCoverageTargets } from "../evaluation/evaluationContract.js";
import {
  resolveArtifactPathBinding,
  resolveJoinBinding,
  resolveOwnerBinding,
  resolveRoleBinding,
  resolveStatePathBinding,
  resolveStatusCodeBinding,
  resolveStatusScopeBinding
} from "./bindings.js";
import { dedupeCaseIds } from "./caseIds.js";

export function deriveWorkflowCoverageTargets(contract: ContractModel): WorkflowCoverageTarget[] {
  const targets: WorkflowCoverageTarget[] = [];
  const add = (target: WorkflowCoverageTarget) => targets.push(target);

  for (const target of getImplementedCoverageTargets()) {
    add({ id: target.id, category: "dimension", label: target.label, required: true });
  }
  if (contract.routing.forbidden.length > 0) {
    add({ id: "dimension:forbidden-routing", category: "dimension", label: "Forbidden route prevention", required: true });
  }
  if (contract.joins.length > 0) {
    add({ id: "dimension:joins", category: "dimension", label: "Required join and callback ordering", required: true });
  }

  for (const role of contract.roles) {
    add({ id: `role:${role.id}`, category: "role", label: `Role ${role.id}`, required: true });
  }
  for (const ownerScope of Object.keys(contract.requiredOwners).sort()) {
    add({ id: `owner:${ownerScope}`, category: "owner", label: `Owner scope ${ownerScope}`, required: true });
  }
  for (const join of contract.joins) {
    add({ id: `join:${join.id}`, category: "join", label: `Join ${join.id}`, required: true });
  }
  for (const route of contract.routing.forbidden) {
    add({ id: `route:${route.id}`, category: "route", label: `Forbidden route ${route.id}`, required: true });
  }
  for (const artifact of contract.artifacts) {
    add({ id: `artifact:${artifact.id}`, category: "artifact", label: `Artifact ${artifact.path}`, required: true });
  }
  for (const state of contract.states) {
    add({ id: `state:${state.id}`, category: "state", label: `State ${state.path}`, required: true });
  }
  for (const status of contract.statuses) {
    add({ id: `status:${status}`, category: "status", label: `Gate status ${status}`, required: true });
  }
  add({ id: "policy:command", category: "policy", label: "Allowed and forbidden command policy", required: true });

  return dedupeTargets(targets);
}

export function recommendedAiCaseCount(contract: ContractModel, options: { coverageMode?: CoverageMode } = {}): number {
  const coverageMode = options.coverageMode ?? "smoke";
  const targetCount = deriveWorkflowCoverageTargets(contract).length;
  const structuralFlowCount = contract.roles.length + contract.joins.length + contract.routing.forbidden.length;
  const evidenceSurfaceCount =
    Object.keys(contract.requiredOwners).length + Math.ceil((contract.artifacts.length + contract.states.length + contract.statuses.length) / 3);
  const baseCount = Math.max(12, structuralFlowCount + Math.ceil(evidenceSurfaceCount / 2));
  if (coverageMode === "smoke") {
    return Math.min(32, baseCount);
  }
  if (coverageMode === "full") {
    return Math.min(128, Math.max(32, baseCount, Math.ceil(targetCount * 0.8)));
  }
  return Math.min(192, Math.max(32, baseCount * 2, targetCount));
}

export function normalizeAiCasePlanBindings(plan: AiCasePlan, contract: ContractModel): AiCasePlan {
  return {
    ...plan,
    cases: dedupeCaseIds(plan.cases).map((testCase) => {
      const coverageTags = testCase.coverageTags?.map(normalizeCoverageTag) ?? [];
      const inferredBindings = inferBindingsFromCoverageTags(contract, coverageTags);
      const rawBindings = { ...inferredBindings, ...(testCase.bindings ?? {}) };
      return {
        ...testCase,
        coverageTags,
        bindings: Object.keys(rawBindings).length > 0 ? normalizeBindings(rawBindings, contract) : undefined
      };
    })
  };
}

export function validateAiCasePlan(plan: AiCasePlan, contract: ContractModel, options: { coverageMode?: CoverageMode } = {}): AiPlanValidation {
  const normalizedPlan = normalizeAiCasePlanBindings(plan, contract);
  const coverageMode = options.coverageMode ?? plan.coverageMode ?? "smoke";
  const targets = deriveWorkflowCoverageTargets(contract);
  const targetIds = new Set(targets.map((target) => target.id));
  const covered = new Set<string>();
  const unknown = new Set<string>();
  const invalidBindings: AiPlanValidation["invalidBindings"] = [];

  for (const testCase of normalizedPlan.cases) {
    const invalidClaimTags = validateBindingClaims(invalidBindings, contract, testCase.id, testCase.coverageTags ?? [], testCase.bindings);
    for (const tag of testCase.coverageTags ?? []) {
      if (targetIds.has(tag)) {
        if (!invalidClaimTags.has(tag)) {
          covered.add(tag);
        }
      } else {
        unknown.add(tag);
      }
    }
    validateRoleBinding(invalidBindings, contract, testCase.id, "primaryRole", testCase.bindings?.primaryRole);
    validateOwnerBinding(invalidBindings, contract, testCase.id, testCase.bindings?.owner);
    validateJoinBinding(invalidBindings, contract, testCase.id, testCase.bindings?.joinId);
    validateArtifactBinding(invalidBindings, contract, testCase.id, testCase.bindings?.artifactPath);
    validateStateBinding(invalidBindings, contract, testCase.id, testCase.bindings?.statePath);
    validateStatusCodeBinding(
      invalidBindings,
      contract,
      testCase.id,
      testCase.bindings?.statusCode,
      testCase.bindings?.statusScope
    );
    validateStatusScopeBinding(
      invalidBindings,
      contract,
      testCase.id,
      testCase.bindings?.statusScope
    );
  }

  const missing = targets.filter((target) => target.required && !covered.has(target.id)).map((target) => target.id);
  const warnings = buildWarnings(plan, targets.length, covered.size, missing.length, unknown.size);
  const status = invalidBindings.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";

  return {
    schemaVersion: "0.1.0",
    coverageMode,
    status,
    recommendedCaseCount: recommendedAiCaseCount(contract, { coverageMode }),
    coverageTargetCount: targets.length,
    coveredCoverageTargetIds: [...covered].sort(),
    missingCoverageTargetIds: missing.sort(),
    unknownCoverageTags: [...unknown].sort(),
    invalidBindings,
    warnings
  };
}

function validateRoleBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  field: "primaryRole",
  value: string | undefined
): void {
  if (value && !resolveRoleBinding(contract, value)) {
    invalidBindings.push({ caseId, field, value, why: "Role binding is not declared in ContractModel roles." });
  }
}

function validateOwnerBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined
): void {
  if (value && !resolveOwnerBinding(contract, value)) {
    invalidBindings.push({ caseId, field: "owner", value, why: "Owner binding is neither a declared role nor a requiredOwner scope." });
  }
}

function validateJoinBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined
): void {
  if (value && !resolveJoinBinding(contract, value)) {
    invalidBindings.push({ caseId, field: "joinId", value, why: "Join binding is not declared in ContractModel joins." });
  }
}

function validateArtifactBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined
): void {
  if (value && contract.artifacts.length + contract.states.length > 0 && !resolveArtifactPathBinding(contract, value)) {
    invalidBindings.push({
      caseId,
      field: "artifactPath",
      value,
      why: "Evidence path binding is not declared in ContractModel artifacts or states."
    });
  }
}

function validateStateBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined
): void {
  if (value && !resolveStatePathBinding(contract, value)) {
    invalidBindings.push({
      caseId,
      field: "statePath",
      value,
      why: "State path binding is not declared in ContractModel states."
    });
  }
}

function validateStatusScopeBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined
): void {
  if (value && !resolveStatusScopeBinding(contract, value)) {
    invalidBindings.push({
      caseId,
      field: "statusScope",
      value,
      why: "Status scope binding is not declared in ContractModel status semantics."
    });
  }
}

function validateStatusCodeBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  value: string | undefined,
  scope: string | undefined
): void {
  if (!value) {
    return;
  }
  if (!resolveStatusCodeBinding(contract, value, scope)) {
    invalidBindings.push({
      caseId,
      field: "statusCode",
      value,
      why: scope
        ? "Status code binding is not declared in the bound status scope."
        : "Status code binding is not declared in ContractModel statuses."
    });
    return;
  }
  const matchingScopes = [
    ...new Set(
      (contract.statusSemantics ?? [])
        .filter((mapping) => mapping.code === value)
        .map((mapping) => mapping.scope)
    )
  ];
  if (!scope && matchingScopes.length > 1) {
    invalidBindings.push({
      caseId,
      field: "statusScope",
      value: matchingScopes.join(","),
      why: `Status code ${value} is declared in multiple scopes; the executable case must bind one statusScope.`
    });
  }
}

function normalizeBindings(bindings: Record<string, string>, contract: ContractModel): Record<string, string> {
  const output = { ...bindings };
  if (output.primaryRole) {
    output.primaryRole = resolveRoleBinding(contract, output.primaryRole) ?? resolveOwnerBinding(contract, output.primaryRole) ?? output.primaryRole.trim();
  }
  if (output.owner) {
    output.owner = resolveOwnerBinding(contract, output.owner) ?? output.owner.trim();
  }
  if (output.joinId) {
    output.joinId = resolveJoinBinding(contract, output.joinId) ?? output.joinId.trim();
  }
  if (output.artifactPath) {
    output.artifactPath = resolveArtifactPathBinding(contract, output.artifactPath) ?? output.artifactPath.trim();
  }
  if (output.statePath) {
    output.statePath = resolveStatePathBinding(contract, output.statePath) ?? output.statePath.trim();
  }
  if (output.statusCode) {
    output.statusCode =
      resolveStatusCodeBinding(contract, output.statusCode, output.statusScope) ??
      output.statusCode.trim();
  }
  if (output.statusScope) {
    output.statusScope =
      resolveStatusScopeBinding(contract, output.statusScope) ??
      output.statusScope.trim();
  }
  return output;
}

function inferBindingsFromCoverageTags(contract: ContractModel, coverageTags: string[]): Record<string, string> {
  const claims = collectBindingClaims(contract, coverageTags);
  const inferred: Record<string, string> = {};
  const primaryRole = unique(claims.primaryRole.map((claim) => claim.value));
  const owner = unique(claims.owner.map((claim) => claim.value));
  const joinId = unique(claims.joinId.map((claim) => claim.value));
  const artifactPath = unique(claims.artifactPath.map((claim) => claim.value));
  const statePath = unique(claims.statePath.map((claim) => claim.value));
  const statusCode = unique(claims.statusCode.map((claim) => claim.value));
  const statusScope = unique(claims.statusScope.map((claim) => claim.value));
  if (primaryRole) {
    inferred.primaryRole = primaryRole;
  }
  if (owner) {
    inferred.owner = owner;
  }
  if (joinId) {
    inferred.joinId = joinId;
  }
  if (artifactPath) {
    inferred.artifactPath = artifactPath;
  }
  if (statePath) {
    inferred.statePath = statePath;
  }
  if (statusCode) {
    inferred.statusCode = statusCode;
  }
  if (statusScope) {
    inferred.statusScope = statusScope;
  }
  return inferred;
}

function validateBindingClaims(
  invalidBindings: AiPlanValidation["invalidBindings"],
  contract: ContractModel,
  caseId: string,
  coverageTags: string[],
  bindings: Record<string, string> | undefined
): Set<string> {
  const claims = collectBindingClaims(contract, coverageTags);
  const invalidClaimTags = new Set<string>();
  const recordInvalid = (claimTags: string[]) => {
    for (const tag of claimTags) {
      invalidClaimTags.add(tag);
    }
  };
  if (!validateClaimedBinding(invalidBindings, caseId, "primaryRole", bindings?.primaryRole, claims.primaryRole.map((claim) => claim.value))) {
    recordInvalid(claims.primaryRole.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "owner", bindings?.owner, claims.owner.map((claim) => claim.value))) {
    recordInvalid(claims.owner.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "joinId", bindings?.joinId, claims.joinId.map((claim) => claim.value))) {
    recordInvalid(claims.joinId.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "artifactPath", bindings?.artifactPath, claims.artifactPath.map((claim) => claim.value))) {
    recordInvalid(claims.artifactPath.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "statePath", bindings?.statePath, claims.statePath.map((claim) => claim.value))) {
    recordInvalid(claims.statePath.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "statusCode", bindings?.statusCode, claims.statusCode.map((claim) => claim.value))) {
    recordInvalid(claims.statusCode.map((claim) => claim.tag));
  }
  if (!validateClaimedBinding(invalidBindings, caseId, "statusScope", bindings?.statusScope, claims.statusScope.map((claim) => claim.value))) {
    recordInvalid(claims.statusScope.map((claim) => claim.tag));
  }
  return invalidClaimTags;
}

function validateClaimedBinding(
  invalidBindings: AiPlanValidation["invalidBindings"],
  caseId: string,
  field:
    | "primaryRole"
    | "owner"
    | "joinId"
    | "artifactPath"
    | "statePath"
    | "statusCode"
    | "statusScope",
  value: string | undefined,
  claims: string[]
): boolean {
  if (claims.length === 0) {
    return true;
  }
  const uniqueClaims = [...new Set(claims)];
  if (uniqueClaims.length > 1) {
    invalidBindings.push({
      caseId,
      field,
      value: value ?? uniqueClaims.join(","),
      why: `Coverage tag(s) claim multiple ${field} targets (${uniqueClaims.join(", ")}), but the executable case binding is a single scalar.`
    });
    return false;
  }
  if (!value) {
    invalidBindings.push({
      caseId,
      field,
      value: uniqueClaims.join(","),
      why: `Coverage tag(s) claim ${field} target(s), but the case has no matching binding.`
    });
    return false;
  }
  if (!uniqueClaims.includes(value)) {
    invalidBindings.push({
      caseId,
      field,
      value,
      why: `Binding does not match coverage tag target(s): ${uniqueClaims.join(", ")}.`
    });
    return false;
  }
  return true;
}

type BindingClaim = { tag: string; value: string };

function collectBindingClaims(
  contract: ContractModel,
  coverageTags: string[]
): {
  primaryRole: BindingClaim[];
  owner: BindingClaim[];
  joinId: BindingClaim[];
  artifactPath: BindingClaim[];
  statePath: BindingClaim[];
  statusCode: BindingClaim[];
  statusScope: BindingClaim[];
} {
  const claims = {
    primaryRole: [] as BindingClaim[],
    owner: [] as BindingClaim[],
    joinId: [] as BindingClaim[],
    artifactPath: [] as BindingClaim[],
    statePath: [] as BindingClaim[],
    statusCode: [] as BindingClaim[],
    statusScope: [] as BindingClaim[]
  };
  for (const tag of coverageTags) {
    if (tag.startsWith("role:")) {
      const role = resolveRoleBinding(contract, tag);
      if (role) {
        claims.primaryRole.push({ tag, value: role });
      }
    } else if (tag.startsWith("owner:")) {
      const owner = resolveOwnerBinding(contract, tag);
      if (owner) {
        claims.owner.push({ tag, value: owner });
      }
    } else if (tag.startsWith("join:")) {
      const join = resolveJoinBinding(contract, tag);
      if (join) {
        claims.joinId.push({ tag, value: join });
      }
    } else if (tag.startsWith("artifact:")) {
      const evidencePath = resolveArtifactPathBinding(contract, tag);
      if (evidencePath) {
        claims.artifactPath.push({ tag, value: evidencePath });
      }
    } else if (tag.startsWith("state:")) {
      const statePath = resolveStatePathBinding(contract, tag);
      if (statePath) {
        claims.statePath.push({ tag, value: statePath });
      }
    } else if (tag.startsWith("status:")) {
      const statusCode = resolveStatusCodeBinding(contract, tag);
      if (statusCode) {
        claims.statusCode.push({ tag, value: statusCode });
        const scopes = [
          ...new Set(
            (contract.statusSemantics ?? [])
              .filter((mapping) => mapping.code === statusCode)
              .map((mapping) => mapping.scope)
          )
        ];
        if (scopes.length === 1) {
          claims.statusScope.push({ tag, value: scopes[0]! });
        }
      }
    }
  }
  return claims;
}

function unique(values: string[]): string | undefined {
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] : undefined;
}

function normalizeCoverageTag(value: string): string {
  const trimmed = value.trim();
  const aliases: Record<string, string> = {
    "dimension:artifact": "dimension:artifacts",
    "dimension:state": "dimension:states",
    "dimension:join": "dimension:joins",
    "dimension:gate-status": "dimension:gate-statuses",
    "dimension:owner": "dimension:owner-routing",
    "dimension:routing": "dimension:owner-routing",
    "dimension:side-effect": "dimension:side-effect-policy",
    "dimension:side-effects": "dimension:side-effect-policy",
    "dimension:budget": "dimension:budget-efficiency",
    "dimension:efficiency": "dimension:budget-efficiency",
    "artifact:block:state": "state:blocked"
  };
  return aliases[trimmed] ?? trimmed;
}

function buildWarnings(plan: AiCasePlan, targetCount: number, coveredCount: number, missingCount: number, unknownCount: number): string[] {
  const warnings: string[] = [];
  if (!plan.workflowUnderstanding) {
    warnings.push("Plan is missing workflowUnderstanding; targetUnderstanding alone is weaker evidence.");
  }
  if (plan.cases.length < 3) {
    warnings.push("Plan has fewer than three cases; workflow-level coverage is likely too narrow.");
  }
  if (targetCount > 0 && coveredCount / targetCount < 0.7) {
    warnings.push(`Coverage tags cover ${coveredCount}/${targetCount} targets; ${missingCount} target(s) remain uncovered.`);
  }
  if (unknownCount > 0) {
    warnings.push(`${unknownCount} coverage tag(s) do not map to ContractModel-derived targets.`);
  }
  return warnings;
}

function dedupeTargets(targets: WorkflowCoverageTarget[]): WorkflowCoverageTarget[] {
  const seen = new Set<string>();
  const output: WorkflowCoverageTarget[] = [];
  for (const target of targets) {
    if (!seen.has(target.id)) {
      seen.add(target.id);
      output.push(target);
    }
  }
  return output;
}
