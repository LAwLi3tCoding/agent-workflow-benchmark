import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { evaluateGate } from "../regression/gate.js";
import { verifyComparisonBundle } from "../regression/compare.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
export async function verifyExternalValidityComparisonEvidence(comparisonPath, options) {
    try {
        if (!options.trustedObserverKeyPath || !options.trustedQualificationKeyPath) {
            return invalid("External validity comparison evidence requires both trusted public key paths.");
        }
        const comparison = await readJson(comparisonPath);
        const verification = await verifyComparisonBundle(comparisonPath, comparison, options);
        if (verification.status !== "VALID") {
            return invalid("Comparison bundle could not be verified against its bundled evidence.");
        }
        const gate = evaluateGate(comparison, verification);
        const summaryIssue = validateComparisonSummary(comparison);
        if (summaryIssue) {
            return invalid(summaryIssue);
        }
        const bundleRoot = path.dirname(comparisonPath);
        const baselineProvenance = await readBoundProvenance(bundleRoot, comparison, comparison.integrity.baselineRef);
        const candidateProvenance = await readBoundProvenance(bundleRoot, comparison, comparison.integrity.candidateRef);
        const provenanceIssue = validatePairedProvenance(baselineProvenance, candidateProvenance);
        if (provenanceIssue) {
            return invalid(provenanceIssue);
        }
        const baselineTraceHash = requiredArtifactHash(baselineProvenance, "workflow-trace.json");
        const candidateTraceHash = requiredArtifactHash(candidateProvenance, "workflow-trace.json");
        if (!baselineTraceHash || !candidateTraceHash) {
            return invalid("Verified provenance is missing workflow-trace artifact hashes.");
        }
        if (baselineTraceHash === candidateTraceHash) {
            return invalid("Baseline and candidate must be distinct signed workflow-trace attempts.");
        }
        return {
            status: "VALID",
            evidence: {
                classification: comparison.classification,
                gateDecision: gate.decision,
                failureCodes: [...new Set(comparison.hardFailures.map((failure) => failure.code))].sort(),
                comparisonHash: comparison.integrity.comparisonHash,
                targetIdHash: sha256Text(baselineProvenance.subject.targetId),
                contractHash: baselineProvenance.subject.contractHash,
                runner: baselineProvenance.conditions.runner.name,
                baselineContentHash: baselineProvenance.subject.contentHash,
                candidateContentHash: candidateProvenance.subject.contentHash,
                attemptFingerprint: sha256Text(stableJson({
                    comparisonHash: comparison.integrity.comparisonHash,
                    baselineAttemptId: baselineProvenance.subject.attemptId,
                    candidateAttemptId: candidateProvenance.subject.attemptId,
                    baselineTraceHash,
                    candidateTraceHash
                }))
            }
        };
    }
    catch {
        return invalid("External validity comparison evidence could not be verified.");
    }
}
function validateComparisonSummary(comparison) {
    for (const side of [comparison.baseline, comparison.candidate]) {
        if (side.provenanceStatus !== "VALID" ||
            side.evidenceKind !== "live" ||
            side.observationLevel !== "workflow_trace" ||
            side.observerQualificationStatus !== "valid") {
            return "Comparison does not contain qualified live workflow-trace evidence for both sides.";
        }
    }
    return undefined;
}
function validatePairedProvenance(baseline, candidate) {
    if (baseline.subject.targetId !== candidate.subject.targetId ||
        baseline.subject.contractHash !== candidate.subject.contractHash) {
        return "Baseline and candidate provenance do not share target and contract identity.";
    }
    if (baseline.conditions.runner.name !== candidate.conditions.runner.name) {
        return "Baseline and candidate provenance runners do not match.";
    }
    if (!["codex", "claude"].includes(baseline.conditions.runner.name)) {
        return "External validity comparison evidence requires codex or claude runner provenance.";
    }
    for (const provenance of [baseline, candidate]) {
        if (provenance.subject.attemptId.length === 0 ||
            provenance.subject.contentHash.length === 0 ||
            provenance.conditions.evidenceKind !== "live" ||
            provenance.conditions.observationLevel !== "workflow_trace" ||
            provenance.conditions.observer?.qualificationStatus !== "valid") {
            return "Bundled provenance is not qualified live workflow-trace evidence.";
        }
    }
    return undefined;
}
function requiredArtifactHash(provenance, ref) {
    const artifact = provenance.integrity.artifacts.find((item) => item.ref === ref);
    return artifact?.sha256;
}
async function readBoundProvenance(bundleRoot, comparison, runRef) {
    const artifactRef = path.posix.join(runRef, "provenance.json");
    const expectedHash = comparison.integrity.artifacts.find((artifact) => artifact.ref === artifactRef)?.sha256;
    if (!expectedHash) {
        throw new Error("Comparison provenance binding is missing.");
    }
    const bytes = await readFile(path.join(bundleRoot, artifactRef));
    const actualHash = `sha256:${createHash("sha256")
        .update(bytes)
        .digest("hex")}`;
    if (actualHash !== expectedHash) {
        throw new Error("Comparison provenance changed after verification.");
    }
    return JSON.parse(bytes.toString("utf8"));
}
function invalid(reason) {
    return { status: "INVALID", reason };
}
