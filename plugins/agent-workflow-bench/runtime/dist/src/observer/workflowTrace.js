import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hashFile, stableJson } from "../utils/hash.js";
import { readJson } from "../utils/io.js";
import { redactSensitiveText } from "../utils/redaction.js";
export async function verifyWorkflowTraceBundle(tracePath, trustedObserverKeyPath, expected) {
    const bundle = await readJson(tracePath);
    assertBundleShape(bundle);
    const trustedKeyBytes = await readFile(trustedObserverKeyPath);
    if (trustedKeyBytes.toString("utf8").includes("PRIVATE KEY")) {
        throw new Error("Trusted observer key must be a public key; private signing keys are not accepted.");
    }
    const publicKey = createPublicKey(trustedKeyBytes);
    if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Trusted observer key must be an Ed25519 public key.");
    }
    const keyFingerprint = publicKeyFingerprint(publicKey.export({ type: "spki", format: "der" }));
    if (bundle.observer.keyFingerprint !== keyFingerprint) {
        throw new Error("Workflow trace observer keyFingerprint does not match the configured trust anchor.");
    }
    const { attestation, ...unsigned } = bundle;
    const signature = Buffer.from(attestation.signature, "base64");
    if (signature.length === 0 ||
        !verify(null, Buffer.from(stableJson(unsigned)), publicKey, signature)) {
        throw new Error("Workflow trace signature verification failed.");
    }
    const serializedEvidence = stableJson(unsigned);
    if (redactSensitiveText(serializedEvidence) !== serializedEvidence) {
        throw new Error("Workflow trace evidence must be pre-redacted before observer attestation.");
    }
    if (bundle.subject.targetId !== expected.targetId ||
        bundle.subject.contractHash !== expected.contractHash ||
        bundle.subject.suite !== expected.suite) {
        throw new Error("Workflow trace subject does not match the target contract and suite.");
    }
    if (bundle.subject.caseSetHash !== expected.caseSetHash) {
        throw new Error("Workflow trace case set hash does not match the materialized benchmark cases.");
    }
    if (expected.runner && stableJson(bundle.subject.runner) !== stableJson(expected.runner)) {
        throw new Error("Workflow trace runner identity does not match provenance.");
    }
    const expectedCaseIds = [...expected.caseIds].sort();
    const observedCaseIds = bundle.cases.map((item) => item.caseId).sort();
    if (new Set(observedCaseIds).size !== observedCaseIds.length ||
        stableJson(observedCaseIds) !== stableJson(expectedCaseIds)) {
        throw new Error("Workflow trace case set does not exactly match the materialized benchmark cases.");
    }
    if (expected.cases) {
        const expectedTemplates = [...expected.cases]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(({ id, templateId }) => ({ id, templateId }));
        const observedTemplates = [...bundle.cases]
            .sort((left, right) => left.caseId.localeCompare(right.caseId))
            .map(({ caseId: id, templateId }) => ({ id, templateId }));
        if (stableJson(observedTemplates) !== stableJson(expectedTemplates)) {
            throw new Error("Workflow trace case templates do not match the materialized benchmark cases.");
        }
    }
    const runs = bundle.cases.map((observed) => validateObservedCase(observed, bundle.subject.contractHash, bundle.subject.runner.name));
    return {
        bundle,
        keyFingerprint,
        traceHash: await hashFile(tracePath),
        eventCount: runs.reduce((total, run) => total + run.events.length, 0),
        runs
    };
}
function validateObservedCase(observed, contractHash, runnerName) {
    if (!observed ||
        typeof observed.caseId !== "string" ||
        !observed.caseId ||
        typeof observed.templateId !== "string" ||
        !observed.templateId ||
        typeof observed.runId !== "string" ||
        !observed.runId ||
        !Array.isArray(observed.events)) {
        throw new Error("Workflow trace contains an invalid observed case.");
    }
    if (!Number.isFinite(observed.wallClockSeconds) ||
        observed.wallClockSeconds < 0 ||
        !Number.isFinite(observed.telemetryCompleteness) ||
        observed.telemetryCompleteness < 0 ||
        observed.telemetryCompleteness > 1) {
        throw new Error(`Workflow trace metrics are invalid for case ${observed.caseId}.`);
    }
    assertTokens(observed.caseId, observed.tokens);
    const eventIds = new Set();
    for (const event of observed.events) {
        assertEvent(observed.caseId, event);
        if (eventIds.has(event.eventId)) {
            throw new Error(`Workflow trace contains duplicate eventId ${event.eventId}.`);
        }
        eventIds.add(event.eventId);
    }
    for (const requiredType of [
        "case_start",
        "contract_observed",
        "runner_start",
        "runner_result",
        "runner_exit",
        "token_usage",
        "case_end"
    ]) {
        if (!observed.events.some((event) => event.type === requiredType)) {
            throw new Error(`Workflow trace case ${observed.caseId} is missing required ${requiredType} evidence.`);
        }
    }
    const caseStart = observed.events.find((event) => event.type === "case_start");
    if (caseStart.payload.caseId !== observed.caseId) {
        throw new Error(`Workflow trace case_start does not match case ${observed.caseId}.`);
    }
    const contractObserved = observed.events.find((event) => event.type === "contract_observed");
    if (contractObserved.payload.contractHash !== contractHash) {
        throw new Error(`Workflow trace contract evidence does not match case ${observed.caseId}.`);
    }
    const tokenUsage = observed.events.find((event) => event.type === "token_usage");
    if (tokenUsage.payload.total !== observed.tokens.total) {
        throw new Error(`Workflow trace token evidence does not match case ${observed.caseId}.`);
    }
    assertTemplateEvidence(observed);
    return {
        runId: observed.runId,
        caseId: observed.caseId,
        runner: {
            name: runnerName,
            comparability: {
                workflowScore: "comparable",
                efficiency: "comparable",
                tokenCost: "comparable"
            }
        },
        events: observed.events,
        wallClockSeconds: observed.wallClockSeconds,
        tokens: observed.tokens,
        telemetryCompleteness: observed.telemetryCompleteness
    };
}
function assertBundleShape(bundle) {
    if (!bundle ||
        bundle.schemaVersion !== "0.1.0" ||
        !bundle.observer ||
        typeof bundle.observer.id !== "string" ||
        !bundle.observer.id ||
        typeof bundle.observer.version !== "string" ||
        !bundle.observer.version ||
        typeof bundle.observer.keyFingerprint !== "string" ||
        !bundle.subject ||
        typeof bundle.subject.targetId !== "string" ||
        typeof bundle.subject.contractHash !== "string" ||
        typeof bundle.subject.suite !== "string" ||
        typeof bundle.subject.caseSetHash !== "string" ||
        !bundle.subject.runner ||
        !["codex", "claude", "opencode"].includes(bundle.subject.runner.name) ||
        typeof bundle.subject.runner.adapterVersion !== "string" ||
        typeof bundle.subject.runner.capabilitiesHash !== "string" ||
        !["read_only_sandbox", "working_directory_only"].includes(bundle.subject.isolation) ||
        !["read_only_no_approval", "runner_default"].includes(bundle.subject.permissionMode) ||
        !Array.isArray(bundle.cases) ||
        !bundle.attestation ||
        bundle.attestation.algorithm !== "ed25519" ||
        typeof bundle.attestation.signature !== "string") {
        throw new Error("Workflow trace bundle is missing required fields.");
    }
}
function assertEvent(caseId, event) {
    if (!event ||
        typeof event.eventId !== "string" ||
        !event.eventId ||
        typeof event.timestamp !== "string" ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        typeof event.actor !== "string" ||
        !event.actor ||
        typeof event.type !== "string" ||
        !runEventTypes.has(event.type) ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload)) {
        throw new Error(`Workflow trace contains an invalid event for case ${caseId}.`);
    }
}
function assertTemplateEvidence(observed) {
    if (observed.templateId === "side-effect-deny") {
        const deniedAttempt = observed.events.find((event) => event.type === "side_effect_attempt" &&
            event.payload.policyDecision === "deny" &&
            event.payload.allowed === false);
        if (!deniedAttempt) {
            throw new Error(`Workflow trace case ${observed.caseId} requires side_effect_attempt evidence with policyDecision=deny and allowed=false.`);
        }
    }
}
function assertTokens(caseId, tokens) {
    if (!tokens ||
        !Number.isFinite(tokens.input) ||
        tokens.input < 0 ||
        !Number.isFinite(tokens.output) ||
        tokens.output < 0 ||
        !Number.isFinite(tokens.total) ||
        tokens.total < 0 ||
        !Number.isFinite(tokens.wasted) ||
        tokens.wasted < 0 ||
        tokens.input + tokens.output !== tokens.total ||
        !["high", "medium", "low", "unavailable"].includes(tokens.costEstimateConfidence)) {
        throw new Error(`Workflow trace token metrics are invalid for case ${caseId}.`);
    }
}
function publicKeyFingerprint(der) {
    return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}
const runEventTypes = new Set([
    "case_start",
    "contract_observed",
    "handoff",
    "gate_decision",
    "artifact_write",
    "state_read",
    "side_effect_attempt",
    "token_usage",
    "runner_start",
    "runner_transcript",
    "runner_result",
    "runner_exit",
    "hard_failure",
    "case_end"
]);
