import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { sha256Text, stableJson } from "../utils/hash.js";
export const ADAPTER_PROTOCOL_VERSION = "1.0.0";
export const ADAPTER_ERROR_CODES = [
    "ADAPTER_CONTRACT_INVALID",
    "ADAPTER_CAPABILITY_UNSUPPORTED",
    "ADAPTER_EXECUTABLE_UNAVAILABLE",
    "ADAPTER_EXECUTION_FAILED",
    "ADAPTER_TIMEOUT",
    "ADAPTER_OUTPUT_INVALID",
    "ADAPTER_EVENT_INVALID",
    "ADAPTER_EVENT_ORDER_INVALID",
    "ADAPTER_EVIDENCE_LIMIT_EXCEEDED",
    "ADAPTER_TOKEN_EVIDENCE_INVALID",
    "ADAPTER_PRIVATE_DATA_REJECTED"
];
export const ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE = [
    "case_start",
    "runner_start",
    "runner_transcript",
    "runner_result",
    "runner_exit",
    "token_usage",
    "case_end"
];
export class AdapterError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "AdapterError";
        this.code = code;
    }
}
export async function loadAdapterContract(filePath) {
    let value;
    try {
        value = JSON.parse(await readFile(filePath, "utf8"));
    }
    catch (error) {
        throw new AdapterError("ADAPTER_CONTRACT_INVALID", `Adapter contract could not be read as JSON: ${path.basename(filePath)}.`, { cause: error });
    }
    const schema = JSON.parse(await readFile(path.join(getBenchmarkRoot(), "schemas/adapter-contract.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) {
        throw new AdapterError("ADAPTER_CONTRACT_INVALID", `Adapter contract schema validation failed: ${ajv.errorsText(validate.errors)}.`);
    }
    return validateAdapterContract(value);
}
export function validateAdapterContract(contract) {
    if (!contract ||
        contract.schemaVersion !== "0.1.0" ||
        contract.artifactType !== "adapter_contract" ||
        contract.protocolVersion !== ADAPTER_PROTOCOL_VERSION ||
        !isPortableId(contract.id) ||
        !isSemver(contract.version) ||
        !contract.displayName?.trim() ||
        !isPortableRef(contract.implementation?.entrypoint) ||
        contract.implementation.runtime !== "node") {
        invalidContract("identity, version, or implementation is invalid");
    }
    if (!contract.compatibility ||
        !/^\^0\.1\.\d+$/u.test(contract.compatibility.awb) ||
        contract.compatibility.caseRunSchema !== "0.1.0" ||
        contract.compatibility.workflowTraceSchema !== "0.1.0") {
        invalidContract("compatibility declaration is invalid");
    }
    if (!contract.capabilities ||
        !Array.isArray(contract.capabilities.entrypointKinds) ||
        new Set(contract.capabilities.entrypointKinds).size !==
            contract.capabilities.entrypointKinds.length ||
        !Array.isArray(contract.capabilities.eventTypes) ||
        new Set(contract.capabilities.eventTypes).size !==
            contract.capabilities.eventTypes.length ||
        !Array.isArray(contract.capabilities.evidenceKinds) ||
        new Set(contract.capabilities.evidenceKinds).size !==
            contract.capabilities.evidenceKinds.length) {
        invalidContract("capability declaration is invalid");
    }
    if (contract.kind === "runner" &&
        (!contract.capabilities.runnerName ||
            !contract.comparability ||
            ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE.some((eventType) => !contract.capabilities.eventTypes.includes(eventType)))) {
        invalidContract("runner adapters must declare a live runner, comparability, and required lifecycle events");
    }
    if (contract.kind === "observer" &&
        (contract.capabilities.runnerName !== undefined ||
            contract.capabilities.signing?.algorithm !== "ed25519" ||
            contract.capabilities.signing.redactionBeforeSigning !== true ||
            contract.capabilities.signing.independentProcessRequired !== true)) {
        invalidContract("Observer adapters must declare independent Ed25519 signing and no runner identity");
    }
    const tokenEvidence = contract.capabilities.tokenEvidence;
    if (!tokenEvidence ||
        (tokenEvidence.required && tokenEvidence.source === "unavailable") ||
        (tokenEvidence.source === "unavailable" &&
            tokenEvidence.aggregation !== "unavailable") ||
        (tokenEvidence.source !== "unavailable" &&
            tokenEvidence.confidence === "unavailable")) {
        invalidContract("token evidence declaration is inconsistent");
    }
    if (!Array.isArray(contract.errorCodes) ||
        new Set(contract.errorCodes).size !== contract.errorCodes.length ||
        contract.errorCodes.some((code) => !ADAPTER_ERROR_CODES.includes(code)) ||
        !ADAPTER_ERROR_CODES.every((code) => contract.errorCodes.includes(code))) {
        invalidContract("stable error-code declaration is incomplete");
    }
    for (const [field, value] of Object.entries(contract.evidenceLimits ?? {})) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            invalidContract(`evidence limit ${field} must be a positive integer`);
        }
    }
    if (Object.keys(contract.evidenceLimits ?? {}).length !== 5 ||
        contract.evidenceLimits.maxPayloadBytes >
            contract.evidenceLimits.maxTotalEvidenceBytes ||
        contract.evidenceLimits.maxTranscriptBytes >
            contract.evidenceLimits.maxTotalEvidenceBytes) {
        invalidContract("evidence limits are incomplete or internally inconsistent");
    }
    if (contract.safety?.automaticTrustEnrollment !== false ||
        contract.safety.automaticWorkflowModification !== false ||
        contract.safety.automaticFixPullRequest !== false ||
        contract.safety.observerPrivateKeyAccessibleToRunner !== false) {
        invalidContract("automatic or private-key side effects must remain disabled");
    }
    return contract;
}
export function adapterContractHash(contract) {
    validateAdapterContract(contract);
    return sha256Text(stableJson(contract));
}
function invalidContract(why) {
    throw new AdapterError("ADAPTER_CONTRACT_INVALID", `Adapter contract ${why}.`);
}
function isPortableId(value) {
    return (typeof value === "string" &&
        /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value));
}
function isSemver(value) {
    return (typeof value === "string" &&
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value));
}
function isPortableRef(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        !path.isAbsolute(value) &&
        !value.split(/[\\/]/u).includes("..") &&
        !value.includes("\\"));
}
