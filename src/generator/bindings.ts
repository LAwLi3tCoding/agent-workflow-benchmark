import type { ContractModel } from "../core/types.js";
import path from "node:path";

export interface CaseBindingDefaults {
  primaryRole?: string;
  owner?: string;
  joinId?: string;
  artifactPath?: string;
  statePath?: string;
  statusCode?: string;
  statusScope?: string;
}

export interface NormalizedCaseBindings {
  primaryRole?: string;
  owner?: string;
  joinId?: string;
  artifactPath?: string;
  statePath?: string;
  statusCode?: string;
  statusScope?: string;
}

export function normalizeCaseBindings(
  contract: ContractModel,
  bindings: Record<string, string> | undefined,
  defaults: CaseBindingDefaults = {}
): Record<string, string> {
  const normalized: Record<string, string> = { ...(bindings ?? {}) };
  const primaryRole = resolveRoleBinding(contract, bindings?.primaryRole ?? defaults.primaryRole);
  const owner = resolveOwnerBinding(contract, bindings?.owner ?? defaults.owner);
  const joinId = resolveJoinBinding(contract, bindings?.joinId ?? defaults.joinId);
  const artifactPath = resolveArtifactPathBinding(contract, bindings?.artifactPath ?? defaults.artifactPath);
  const statePath = resolveStatePathBinding(contract, bindings?.statePath ?? defaults.statePath);
  const statusScope = resolveStatusScopeBinding(
    contract,
    bindings?.statusScope ?? defaults.statusScope
  );
  const statusCode = resolveStatusCodeBinding(
    contract,
    bindings?.statusCode ?? defaults.statusCode,
    statusScope
  );

  if (primaryRole) {
    normalized.primaryRole = primaryRole;
  }
  if (owner) {
    normalized.owner = owner;
  }
  if (joinId) {
    normalized.joinId = joinId;
  }
  if (artifactPath) {
    normalized.artifactPath = artifactPath;
  }
  if (statePath) {
    normalized.statePath = statePath;
  }
  if (statusCode) {
    normalized.statusCode = statusCode;
  }
  if (statusScope) {
    normalized.statusScope = statusScope;
  }

  return normalized;
}

export function resolveRoleBinding(contract: ContractModel, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const roleId = stripPrefix(value.trim(), "role:");
  return contract.roles.some((role) => role.id === roleId) ? roleId : undefined;
}

export function resolveOwnerBinding(contract: ContractModel, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const withoutOwnerPrefix = stripPrefix(value.trim(), "owner:");
  const ownerRole = contract.requiredOwners[withoutOwnerPrefix];
  if (ownerRole) {
    return ownerRole;
  }
  const ownerScopeRole = contract.roles.find((role) => role.ownerScopes.includes(withoutOwnerPrefix));
  if (ownerScopeRole) {
    return ownerScopeRole.id;
  }
  return resolveRoleBinding(contract, value);
}

export function resolveJoinBinding(contract: ContractModel, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const joinId = stripPrefix(value.trim(), "join:");
  const byId = contract.joins.find((join) => join.id === joinId);
  if (byId) {
    return byId.id;
  }
  const byArtifact = contract.joins.find((join) => join.artifact === joinId);
  return byArtifact?.id;
}

export function resolveArtifactPathBinding(contract: ContractModel, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const evidenceValue = stripKnownPrefix(value, ["artifact", "state", "path"]);
  const evidencePaths = [...contract.artifacts, ...contract.states];
  const byPath = evidencePaths.find((evidence) => evidence.path === evidenceValue);
  if (byPath) {
    return byPath.path;
  }
  const byId = evidencePaths.find((evidence) => evidence.id === evidenceValue);
  if (byId) {
    return byId.path;
  }
  const byUniqueBasename = evidencePaths.filter((evidence) => path.basename(evidence.path) === path.basename(evidenceValue));
  return byUniqueBasename.length === 1 ? byUniqueBasename[0].path : undefined;
}

export function resolveStatePathBinding(
  contract: ContractModel,
  value: string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  const stateValue = stripKnownPrefix(value, ["state", "path"]);
  const byPath = contract.states.find((state) => state.path === stateValue);
  if (byPath) {
    return byPath.path;
  }
  const byId = contract.states.find((state) => state.id === stateValue);
  if (byId) {
    return byId.path;
  }
  const byUniqueBasename = contract.states.filter(
    (state) => path.basename(state.path) === path.basename(stateValue)
  );
  return byUniqueBasename.length === 1 ? byUniqueBasename[0].path : undefined;
}

export function resolveStatusScopeBinding(
  contract: ContractModel,
  value: string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  const scope = value.trim();
  return (contract.statusSemantics ?? []).some(
    (mapping) => mapping.scope === scope
  )
    ? scope
    : undefined;
}

export function resolveStatusCodeBinding(
  contract: ContractModel,
  value: string | undefined,
  scope?: string
): string | undefined {
  if (!value) {
    return undefined;
  }
  const code = stripPrefix(value.trim(), "status:");
  if (!contract.statuses.includes(code)) {
    return undefined;
  }
  if (
    scope &&
    !(contract.statusSemantics ?? []).some(
      (mapping) => mapping.code === code && mapping.scope === scope
    )
  ) {
    return undefined;
  }
  return code;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function stripKnownPrefix(value: string, prefixes: string[]): string {
  const trimmed = value.trim();
  for (const prefix of prefixes) {
    const marker = `${prefix}:`;
    if (trimmed.startsWith(marker)) {
      return trimmed.slice(marker.length);
    }
  }
  return trimmed;
}
