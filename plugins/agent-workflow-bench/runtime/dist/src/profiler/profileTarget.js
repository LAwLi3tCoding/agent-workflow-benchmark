import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildContractModel } from "../core/contractModel.js";
import { hashFile } from "../utils/hash.js";
export async function profileTarget(target) {
    const scannedFiles = [];
    const missingFiles = [];
    const warnings = [];
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
        }
        catch {
            missingFiles.push(role.path);
        }
    }
    for (const entrypoint of target.entrypoints) {
        if (entrypoint.kind === "file" && entrypoint.path) {
            const entrypointPath = path.join(target.root, entrypoint.path);
            try {
                await stat(entrypointPath);
            }
            catch {
                missingFiles.push(entrypoint.path);
            }
        }
    }
    if (target.contracts.joins.length === 0) {
        warnings.push("No required joins declared; required-join template will use notApplicable for stricter targets.");
    }
    const portableRoot = "target://root";
    const contract = buildContractModel(target);
    return {
        evidence: {
            targetId: target.id,
            root: portableRoot,
            scannedFiles,
            missingFiles: [...new Set(missingFiles)].sort(),
            warnings
        },
        contract
    };
}
async function readEvidenceExcerpt(filePath) {
    const raw = await readFile(filePath, "utf8");
    return raw.replace(/\s+$/u, "").slice(0, 4000);
}
