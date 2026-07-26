import { readFile } from "node:fs/promises";
import { scoreCase } from "../scorer/score.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { ADAPTER_PROTOCOL_VERSION, ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE, AdapterError, adapterContractHash, validateAdapterContract } from "./sdk.js";
export function runAdapterDeclarationConformance(contract, options = {}) {
    const checks = [];
    try {
        validateAdapterContract(contract);
        checks.push(pass("contract", "Adapter contract is schema-valid."));
    }
    catch (error) {
        checks.push(fail("contract", adapterErrorCode(error), errorMessage(error)));
    }
    if (contract.safety?.automaticTrustEnrollment === false &&
        contract.safety.automaticWorkflowModification === false &&
        contract.safety.automaticFixPullRequest === false &&
        contract.safety.observerPrivateKeyAccessibleToRunner === false) {
        checks.push(pass("safety", "Trust enrollment, target modification, fix PR creation, and Runner key access are disabled."));
    }
    else {
        checks.push(fail("safety", "ADAPTER_CONTRACT_INVALID", "Adapter safety controls are not fail-closed."));
    }
    if (contract.kind === "runner" &&
        ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE.every((eventType) => contract.capabilities?.eventTypes?.includes(eventType))) {
        checks.push(pass("event-specification", "Runner declares the canonical lifecycle event sequence."));
    }
    else if (contract.kind === "observer" &&
        contract.capabilities?.signing?.algorithm === "ed25519" &&
        contract.capabilities.signing.redactionBeforeSigning === true &&
        contract.capabilities.signing.independentProcessRequired === true) {
        checks.push(pass("event-specification", "Observer declares independent redaction-before-signing evidence."));
    }
    else {
        checks.push(fail("event-specification", "ADAPTER_CONTRACT_INVALID", "Adapter event or Observer signing declaration is incomplete."));
    }
    return finalize(contract, options.generatedAt, checks);
}
export async function runRunnerAdapterConformance(input) {
    const declaration = runAdapterDeclarationConformance(input.adapter.contract, { generatedAt: input.generatedAt });
    const checks = [...declaration.checks];
    if (input.adapter.contract.kind !== "runner") {
        checks.push(fail("adapter-kind", "ADAPTER_CONTRACT_INVALID", "Runner conformance requires a runner Adapter contract."));
        return finalize(input.adapter.contract, input.generatedAt, checks);
    }
    let run;
    try {
        run = await input.adapter.run(input.context);
        checks.push(pass("execution", "Adapter execution returned a CaseRun."));
    }
    catch (error) {
        checks.push(fail("execution", adapterErrorCode(error), errorMessage(error)));
        return finalize(input.adapter.contract, input.generatedAt, checks);
    }
    checks.push(...validateCaseIdentity(run, input.context));
    checks.push(...validateEvents(run, input.adapter.contract));
    checks.push(...validateTokenEvidence(run, input.adapter.contract));
    checks.push(...(await validateEvidenceBounds(run, input.adapter.contract, input.context)));
    checks.push(...validateScorerCompatibility(run, input.context));
    return finalize(input.adapter.contract, input.generatedAt, checks);
}
export function assertAdapterConformanceReportIntegrity(report) {
    const { integrity, ...content } = report;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(content))) {
        throw new AdapterError("ADAPTER_OUTPUT_INVALID", "Adapter conformance report integrity verification failed.");
    }
    const failed = report.checks.filter((check) => check.status === "FAIL");
    const expectedDecision = failed.length === 0 ? "PASS" : "FAIL";
    const expectedReasons = [
        ...new Set(failed.map((check) => check.reasonCode ?? "ADAPTER_OUTPUT_INVALID"))
    ];
    if (report.decision !== expectedDecision ||
        stableJson(report.reasonCodes) !== stableJson(expectedReasons) ||
        report.releaseDisposition !== "DIAGNOSTIC_ONLY") {
        throw new AdapterError("ADAPTER_OUTPUT_INVALID", "Adapter conformance decision is inconsistent with its checks.");
    }
}
function validateCaseIdentity(run, context) {
    const expectedRunner = context.capability.name;
    if (run.caseId !== context.testCase.id ||
        !run.runId ||
        run.runner?.name !== expectedRunner ||
        run.runner.name !== context.capability.name) {
        return [
            fail("case-identity", "ADAPTER_OUTPUT_INVALID", "CaseRun identity does not match the requested case and runner.")
        ];
    }
    return [
        pass("case-identity", "CaseRun is bound to the requested case and runner capability.")
    ];
}
function validateEvents(run, contract) {
    if (!Array.isArray(run.events) || run.events.length === 0) {
        return [
            fail("event-shape", "ADAPTER_EVENT_INVALID", "CaseRun did not contain lifecycle events.")
        ];
    }
    const ids = new Set();
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    for (const event of run.events) {
        const timestamp = Date.parse(event.timestamp);
        if (!event.eventId ||
            ids.has(event.eventId) ||
            !Number.isFinite(timestamp) ||
            timestamp < previousTimestamp ||
            !contract.capabilities.eventTypes.includes(event.type) ||
            !isRecord(event.payload)) {
            return [
                fail("event-shape", "ADAPTER_EVENT_INVALID", "Events must be unique, ordered, declared, and structurally valid.")
            ];
        }
        ids.add(event.eventId);
        previousTimestamp = timestamp;
    }
    const positions = ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE.map((type) => run.events.findIndex((event) => event.type === type));
    if (positions.some((position) => position < 0) ||
        positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
        return [
            fail("event-order", "ADAPTER_EVENT_ORDER_INVALID", "Required runner lifecycle events are missing or out of order.")
        ];
    }
    const runnerResult = run.events.find((event) => event.type === "runner_result");
    const runnerExit = run.events.find((event) => event.type === "runner_exit");
    const caseEnd = run.events.find((event) => event.type === "case_end");
    if (!runnerResult || !runnerExit || !caseEnd) {
        return [
            fail("event-order", "ADAPTER_EVENT_ORDER_INVALID", "Required runner lifecycle events are missing.")
        ];
    }
    if (!["PASS", "FAIL", "UNVERIFIED"].includes(String(runnerResult.payload.verdict ?? "").toUpperCase()) ||
        !Number.isInteger(runnerExit.payload.exitCode) ||
        typeof runnerExit.payload.timedOut !== "boolean" ||
        !["completed", "runner_failed"].includes(String(caseEnd.payload.status ?? ""))) {
        return [
            fail("event-semantics", "ADAPTER_OUTPUT_INVALID", "Runner result, exit, or terminal status uses unsupported semantics.")
        ];
    }
    if (runnerExit.payload.exitCode !== 0 ||
        runnerExit.payload.timedOut !== false ||
        caseEnd.payload.status !== "completed") {
        return [
            fail("execution-result", "ADAPTER_EXECUTION_FAILED", "The conformance fixture did not complete successfully.")
        ];
    }
    if (String(runnerResult.payload.verdict).toUpperCase() !== "PASS") {
        return [
            fail("fixture-verdict", "ADAPTER_OUTPUT_INVALID", "The known-good conformance fixture did not produce PASS.")
        ];
    }
    return [
        pass("event-shape", "Events are unique, declared, and time ordered."),
        pass("event-order", "Required runner lifecycle events are present in canonical order."),
        pass("event-semantics", "Runner result, exit, and terminal status use stable semantics."),
        pass("execution-result", "The conformance fixture completed with a successful exit."),
        pass("fixture-verdict", "The known-good conformance fixture produced PASS.")
    ];
}
function validateTokenEvidence(run, contract) {
    const tokenEvents = run.events.filter((event) => event.type === "token_usage");
    const token = tokenEvents[0]?.payload;
    const expectedSource = contract.capabilities.tokenEvidence.source;
    const validRunTokens = isNonNegativeInteger(run.tokens.input) &&
        isNonNegativeInteger(run.tokens.output) &&
        isNonNegativeInteger(run.tokens.total) &&
        isNonNegativeInteger(run.tokens.wasted) &&
        run.tokens.total === run.tokens.input + run.tokens.output &&
        run.tokens.wasted <= run.tokens.total;
    const validEvent = tokenEvents.length === 1 &&
        token !== undefined &&
        token.input === run.tokens.input &&
        token.output === run.tokens.output &&
        token.total === run.tokens.total &&
        token.wasted === run.tokens.wasted &&
        token.source === expectedSource &&
        token.aggregation ===
            contract.capabilities.tokenEvidence.aggregation;
    if (!validRunTokens || !validEvent) {
        return [
            fail("token-evidence", "ADAPTER_TOKEN_EVIDENCE_INVALID", "Token totals, source, or aggregation do not match the canonical token_usage event.")
        ];
    }
    return [
        pass("token-evidence", "Token totals, source, and aggregation are bound to one canonical token_usage event.")
    ];
}
async function validateEvidenceBounds(run, contract, context) {
    const limits = contract.evidenceLimits;
    const serialized = stableJson(run);
    const runBytes = Buffer.byteLength(serialized);
    const payloadTooLarge = run.events.some((event) => Buffer.byteLength(stableJson(event.payload)) > limits.maxPayloadBytes);
    if (run.events.length > limits.maxEventsPerCase ||
        payloadTooLarge ||
        runBytes > limits.maxTotalEvidenceBytes) {
        return [
            fail("evidence-limits", "ADAPTER_EVIDENCE_LIMIT_EXCEEDED", "Adapter evidence exceeded the declared event, payload, or total bound.")
        ];
    }
    const artifactFiles = [
        {
            kind: "transcript",
            file: context.transcriptPath,
            maximumBytes: limits.maxTranscriptBytes,
            required: true
        },
        {
            kind: "last-message",
            file: context.lastMessagePath,
            maximumBytes: limits.maxPayloadBytes,
            required: true
        }
    ];
    const stderrPath = context.transcriptPath.replace(/\.jsonl$/u, ".stderr.log");
    if (stderrPath !== context.transcriptPath) {
        artifactFiles.push({
            kind: "stderr",
            file: stderrPath,
            maximumBytes: limits.maxTranscriptBytes,
            required: false
        });
    }
    let artifactBytes = 0;
    for (const artifact of artifactFiles) {
        let bytes;
        try {
            bytes = await readFile(artifact.file);
        }
        catch (error) {
            if (!artifact.required && isMissingFile(error)) {
                continue;
            }
            return [
                fail("evidence-artifacts", "ADAPTER_OUTPUT_INVALID", `Adapter ${artifact.kind} evidence is missing or unreadable.`)
            ];
        }
        artifactBytes += bytes.length;
        if (bytes.length > artifact.maximumBytes ||
            runBytes + artifactBytes > limits.maxTotalEvidenceBytes) {
            return [
                fail("evidence-limits", "ADAPTER_EVIDENCE_LIMIT_EXCEEDED", "Adapter file evidence exceeded the declared transcript, payload, or total bound.")
            ];
        }
        const text = bytes.toString("utf8");
        if (redactSensitiveText(text) !== text) {
            return [
                fail("evidence-redaction", "ADAPTER_PRIVATE_DATA_REJECTED", "Adapter file evidence contains a value that requires redaction.")
            ];
        }
    }
    if (redactSensitiveText(serialized) !== serialized) {
        return [
            fail("evidence-redaction", "ADAPTER_PRIVATE_DATA_REJECTED", "Adapter evidence contains a value that requires redaction.")
        ];
    }
    return [
        pass("evidence-limits", "Adapter events and referenced files stay within declared deterministic bounds."),
        pass("evidence-artifacts", "Adapter transcript and final-message evidence are present and readable."),
        pass("evidence-redaction", "Portable CaseRun evidence passes the public redaction boundary.")
    ];
}
function isMissingFile(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT");
}
function validateScorerCompatibility(run, context) {
    try {
        const result = scoreCase(context.testCase, run);
        if (result.caseId !== context.testCase.id ||
            result.runner.name !== context.capability.name) {
            throw new Error("Scorer output identity did not match the Adapter run.");
        }
        return [
            pass("scorer-compatibility", "Existing core scorer accepted the Adapter CaseRun without translation.")
        ];
    }
    catch (error) {
        return [
            fail("scorer-compatibility", "ADAPTER_OUTPUT_INVALID", `Existing core scorer rejected the Adapter CaseRun: ${errorMessage(error)}`)
        ];
    }
}
function finalize(contract, generatedAt, checks) {
    const failed = checks.filter((check) => check.status === "FAIL");
    const reasonCodes = [
        ...new Set(failed.map((check) => check.reasonCode ?? "ADAPTER_OUTPUT_INVALID"))
    ];
    const reportWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "adapter_conformance_report",
        protocolVersion: ADAPTER_PROTOCOL_VERSION,
        generatedAt: validDate(generatedAt),
        adapter: {
            id: contract.id,
            kind: contract.kind,
            version: contract.version,
            contractHash: safeContractHash(contract)
        },
        decision: failed.length === 0 ? "PASS" : "FAIL",
        releaseDisposition: "DIAGNOSTIC_ONLY",
        reasonCodes,
        checks,
        safety: contract.safety
    };
    return {
        ...reportWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(reportWithoutIntegrity))
        }
    };
}
function safeContractHash(contract) {
    try {
        return adapterContractHash(contract);
    }
    catch {
        return sha256Text(stableJson(contract));
    }
}
function pass(id, why) {
    return { id, status: "PASS", why };
}
function fail(id, reasonCode, why) {
    return { id, status: "FAIL", reasonCode, why: boundedMessage(why) };
}
function adapterErrorCode(error) {
    return error instanceof AdapterError
        ? error.code
        : "ADAPTER_EXECUTION_FAILED";
}
function errorMessage(error) {
    return boundedMessage(error instanceof Error ? error.message : "Unknown Adapter failure.");
}
function boundedMessage(value) {
    return value.slice(0, 4096);
}
function validDate(value) {
    const generatedAt = value ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(generatedAt))) {
        throw new AdapterError("ADAPTER_OUTPUT_INVALID", "Adapter conformance generatedAt must be an ISO timestamp.");
    }
    return generatedAt;
}
function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
