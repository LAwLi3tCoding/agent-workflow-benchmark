import type { ContractModel, TargetPack } from "./types.js";
import { sha256Text, stableJson } from "../utils/hash.js";

export const CONTRACT_HASH_FIELDS = [
  "entrypoints",
  "roles",
  "statuses",
  "requiredOwners",
  "routing",
  "joins",
  "artifacts",
  "states",
  "budgets",
  "commandPolicy"
] as const;

export function buildContractModel(target: TargetPack): ContractModel {
  const contractBase: Omit<ContractModel, "contractHash"> = {
    schemaVersion: "0.1.0",
    targetId: target.id,
    targetType: target.targetType,
    root: "target://root",
    entrypoints: target.entrypoints,
    roles: target.roles,
    statuses: target.contracts.statuses,
    requiredOwners: target.contracts.requiredOwners,
    routing: target.contracts.routing,
    joins: target.contracts.joins,
    artifacts: target.contracts.artifacts,
    states: target.contracts.states,
    budgets: target.contracts.budgets,
    commandPolicy: target.commandPolicy,
    evidenceRefs: declaredEvidenceRefs(target)
  };
  return {
    ...contractBase,
    contractHash: sha256Text(stableJson(contractBase))
  };
}

function declaredEvidenceRefs(target: TargetPack): string[] {
  return [
    ...new Set([
      ...target.roles.map((role) => role.path),
      ...target.entrypoints.flatMap((entrypoint) =>
        entrypoint.kind === "file" && entrypoint.path ? [entrypoint.path] : []
      )
    ])
  ].sort();
}
