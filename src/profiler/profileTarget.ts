import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContractModel, ProfileResult, TargetPack } from "../core/types.js";
import { hashFile, sha256Text, stableJson } from "../utils/hash.js";

export async function profileTarget(target: TargetPack): Promise<ProfileResult> {
  const scannedFiles: Array<{ path: string; sha256: string; bytes: number; excerpt?: string }> = [];
  const missingFiles: string[] = [];
  const warnings: string[] = [];

  for (const role of target.roles) {
    const rolePath = path.join(target.root, role.path);
    try {
      const info = await stat(rolePath);
      scannedFiles.push({
        path: role.path,
        sha256: await hashFile(rolePath),
        bytes: info.size,
        excerpt: await readEvidenceExcerpt(rolePath)
      });
    } catch {
      missingFiles.push(role.path);
    }
  }

  for (const entrypoint of target.entrypoints) {
    if (entrypoint.kind === "file" && entrypoint.path) {
      const entrypointPath = path.join(target.root, entrypoint.path);
      try {
        await stat(entrypointPath);
      } catch {
        missingFiles.push(entrypoint.path);
      }
    }
  }

  if (target.contracts.joins.length === 0) {
    warnings.push("No required joins declared; required-join template will use notApplicable for stricter targets.");
  }

  const contractBase: Omit<ContractModel, "contractHash"> = {
    schemaVersion: "0.1.0",
    targetId: target.id,
    targetType: target.targetType,
    root: target.root,
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
    evidenceRefs: scannedFiles.map((file) => file.path)
  };
  const contract: ContractModel = {
    ...contractBase,
    contractHash: sha256Text(stableJson(contractBase))
  };

  return {
    evidence: {
      targetId: target.id,
      root: target.root,
      scannedFiles,
      missingFiles: [...new Set(missingFiles)].sort(),
      warnings
    },
    contract
  };
}

async function readEvidenceExcerpt(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  return raw.replace(/\s+$/u, "").slice(0, 4000);
}
