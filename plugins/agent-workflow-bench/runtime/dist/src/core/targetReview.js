import path from "node:path";
import { buildContractModel, contractHashFieldsFor } from "./contractModel.js";
import { hashFile, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
export async function assertRegisteredTargetReview(target, benchmarkRoot) {
    const review = target.contractReview;
    if (!review || review.status !== "reviewed") {
        throw new Error(`Registered target ${target.id} must be owner-reviewed; draft target packs are non-gateable.`);
    }
    const artifactPath = resolvePortableArtifactPath(benchmarkRoot, review.artifactPath);
    const actualArtifactHash = await hashFile(artifactPath);
    if (actualArtifactHash !== review.artifactHash) {
        throw new Error(`Registered target ${target.id} contract review artifact hash does not match ${review.artifactPath}.`);
    }
    const artifact = await readJson(artifactPath);
    assertArtifactShape(artifact);
    const contract = buildContractModel(target);
    if (artifact.targetId !== target.id ||
        artifact.contractHash !== contract.contractHash ||
        artifact.decision !== "approved" ||
        artifact.reviewerId !== review.reviewerId ||
        artifact.reviewedAt !== review.reviewedAt ||
        stableJson(artifact.reviewedContractFields) !==
            stableJson(contractHashFieldsFor(target))) {
        throw new Error(`Registered target ${target.id} contract-validity artifact does not approve the current contractHash.`);
    }
}
function resolvePortableArtifactPath(benchmarkRoot, artifactRef) {
    if (!artifactRef || path.isAbsolute(artifactRef)) {
        throw new Error("Target contract review artifactPath must be repository-relative.");
    }
    const resolved = path.resolve(benchmarkRoot, artifactRef);
    const relative = path.relative(benchmarkRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Target contract review artifactPath must stay inside the benchmark package.");
    }
    return resolved;
}
function assertArtifactShape(artifact) {
    if (!artifact ||
        artifact.schemaVersion !== "0.1.0" ||
        artifact.artifactType !== "contract-validity" ||
        typeof artifact.targetId !== "string" ||
        typeof artifact.contractHash !== "string" ||
        artifact.decision !== "approved" ||
        typeof artifact.reviewerId !== "string" ||
        !artifact.reviewerId ||
        typeof artifact.reviewedAt !== "string" ||
        !Number.isFinite(Date.parse(artifact.reviewedAt)) ||
        !Array.isArray(artifact.reviewedContractFields)) {
        throw new Error("Target contract-validity artifact is missing required fields.");
    }
}
