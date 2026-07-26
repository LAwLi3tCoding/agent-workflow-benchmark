import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BenchmarkCase,
  CaseRun,
  ContractModel,
  RunnerCapability,
  RunEvent
} from "../core/types.js";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import type {
  ReferenceObservationRequest,
  ReferenceObservationResult
} from "../observer/referenceObserver.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { createAjv2020 } from "../utils/jsonSchema.js";

export const ADAPTER_PROTOCOL_VERSION = "1.0.0" as const;

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
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];
export type AdapterKind = "runner" | "observer";
export type AdapterEvidenceKind =
  | "filesystem"
  | "tool"
  | "process"
  | "network"
  | "artifact"
  | "state"
  | "side_effect"
  | "token";

export const ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE = [
  "case_start",
  "runner_start",
  "runner_transcript",
  "runner_result",
  "runner_exit",
  "token_usage",
  "case_end"
] as const satisfies readonly RunEvent["type"][];

export interface AdapterContract {
  schemaVersion: "0.1.0";
  artifactType: "adapter_contract";
  protocolVersion: typeof ADAPTER_PROTOCOL_VERSION;
  id: string;
  version: string;
  kind: AdapterKind;
  displayName: string;
  implementation: {
    runtime: "node";
    entrypoint: string;
  };
  capabilities: {
    runnerName?: Exclude<RunnerCapability["name"], "simulated">;
    entrypointKinds: Array<"file" | "cli">;
    eventTypes: RunEvent["type"][];
    evidenceKinds: AdapterEvidenceKind[];
    tokenEvidence: {
      source: "native" | "estimated" | "unavailable";
      confidence: "high" | "medium" | "low" | "unavailable";
      aggregation: "message_final" | "step_sum" | "unavailable";
      required: boolean;
    };
    signing?: {
      algorithm: "ed25519";
      redactionBeforeSigning: true;
      independentProcessRequired: true;
    };
  };
  errorCodes: AdapterErrorCode[];
  evidenceLimits: {
    maxEventsPerCase: number;
    maxPayloadBytes: number;
    maxTranscriptBytes: number;
    maxTotalEvidenceBytes: number;
    maxErrorMessageBytes: number;
  };
  compatibility: {
    awb: string;
    caseRunSchema: "0.1.0";
    workflowTraceSchema: "0.1.0";
  };
  comparability?: RunnerCapability["comparability"];
  safety: {
    automaticTrustEnrollment: false;
    automaticWorkflowModification: false;
    automaticFixPullRequest: false;
    observerPrivateKeyAccessibleToRunner: false;
  };
}

export interface RunnerAdapterRunContext {
  testCase: BenchmarkCase;
  contract: ContractModel;
  capability: RunnerCapability;
  sandboxRoot: string;
  transcriptPath: string;
  lastMessagePath: string;
  timeoutMs: number;
  model?: string;
  env?: Record<string, string>;
}

export interface RunnerAdapter {
  contract: AdapterContract;
  run(context: RunnerAdapterRunContext): Promise<CaseRun>;
}

export interface ObserverAdapter {
  contract: AdapterContract;
  observe(options: {
    request: ReferenceObservationRequest;
    privateKeyPath: string;
    outputPath: string;
  }): Promise<ReferenceObservationResult>;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterError";
    this.code = code;
  }
}

export async function loadAdapterContract(
  filePath: string
): Promise<AdapterContract> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new AdapterError(
      "ADAPTER_CONTRACT_INVALID",
      `Adapter contract could not be read as JSON: ${path.basename(filePath)}.`,
      { cause: error }
    );
  }
  const schema = JSON.parse(
    await readFile(
      path.join(getBenchmarkRoot(), "schemas/adapter-contract.schema.json"),
      "utf8"
    )
  ) as object;
  const ajv = createAjv2020();
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new AdapterError(
      "ADAPTER_CONTRACT_INVALID",
      `Adapter contract schema validation failed: ${ajv.errorsText(
        validate.errors
      )}.`
    );
  }
  return validateAdapterContract(value as AdapterContract);
}

export function validateAdapterContract(
  contract: AdapterContract
): AdapterContract {
  if (
    !contract ||
    contract.schemaVersion !== "0.1.0" ||
    contract.artifactType !== "adapter_contract" ||
    contract.protocolVersion !== ADAPTER_PROTOCOL_VERSION ||
    !isPortableId(contract.id) ||
    !isSemver(contract.version) ||
    !contract.displayName?.trim() ||
    !isPortableRef(contract.implementation?.entrypoint) ||
    contract.implementation.runtime !== "node"
  ) {
    invalidContract("identity, version, or implementation is invalid");
  }
  if (
    !contract.compatibility ||
    !/^\^0\.1\.\d+$/u.test(contract.compatibility.awb) ||
    contract.compatibility.caseRunSchema !== "0.1.0" ||
    contract.compatibility.workflowTraceSchema !== "0.1.0"
  ) {
    invalidContract("compatibility declaration is invalid");
  }
  if (
    !contract.capabilities ||
    !Array.isArray(contract.capabilities.entrypointKinds) ||
    new Set(contract.capabilities.entrypointKinds).size !==
      contract.capabilities.entrypointKinds.length ||
    !Array.isArray(contract.capabilities.eventTypes) ||
    new Set(contract.capabilities.eventTypes).size !==
      contract.capabilities.eventTypes.length ||
    !Array.isArray(contract.capabilities.evidenceKinds) ||
    new Set(contract.capabilities.evidenceKinds).size !==
      contract.capabilities.evidenceKinds.length
  ) {
    invalidContract("capability declaration is invalid");
  }
  if (
    contract.kind === "runner" &&
    (!contract.capabilities.runnerName ||
      !contract.comparability ||
      ADAPTER_REQUIRED_RUNNER_EVENT_SEQUENCE.some(
        (eventType) => !contract.capabilities.eventTypes.includes(eventType)
      ))
  ) {
    invalidContract(
      "runner adapters must declare a live runner, comparability, and required lifecycle events"
    );
  }
  if (
    contract.kind === "observer" &&
    (contract.capabilities.runnerName !== undefined ||
      contract.capabilities.signing?.algorithm !== "ed25519" ||
      contract.capabilities.signing.redactionBeforeSigning !== true ||
      contract.capabilities.signing.independentProcessRequired !== true)
  ) {
    invalidContract(
      "Observer adapters must declare independent Ed25519 signing and no runner identity"
    );
  }
  const tokenEvidence = contract.capabilities.tokenEvidence;
  if (
    !tokenEvidence ||
    (tokenEvidence.required && tokenEvidence.source === "unavailable") ||
    (tokenEvidence.source === "unavailable" &&
      tokenEvidence.aggregation !== "unavailable") ||
    (tokenEvidence.source !== "unavailable" &&
      tokenEvidence.confidence === "unavailable")
  ) {
    invalidContract("token evidence declaration is inconsistent");
  }
  if (
    !Array.isArray(contract.errorCodes) ||
    new Set(contract.errorCodes).size !== contract.errorCodes.length ||
    contract.errorCodes.some(
      (code) => !ADAPTER_ERROR_CODES.includes(code)
    ) ||
    !ADAPTER_ERROR_CODES.every((code) => contract.errorCodes.includes(code))
  ) {
    invalidContract("stable error-code declaration is incomplete");
  }
  for (const [field, value] of Object.entries(contract.evidenceLimits ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalidContract(`evidence limit ${field} must be a positive integer`);
    }
  }
  if (
    Object.keys(contract.evidenceLimits ?? {}).length !== 5 ||
    contract.evidenceLimits.maxPayloadBytes >
      contract.evidenceLimits.maxTotalEvidenceBytes ||
    contract.evidenceLimits.maxTranscriptBytes >
      contract.evidenceLimits.maxTotalEvidenceBytes
  ) {
    invalidContract("evidence limits are incomplete or internally inconsistent");
  }
  if (
    contract.safety?.automaticTrustEnrollment !== false ||
    contract.safety.automaticWorkflowModification !== false ||
    contract.safety.automaticFixPullRequest !== false ||
    contract.safety.observerPrivateKeyAccessibleToRunner !== false
  ) {
    invalidContract("automatic or private-key side effects must remain disabled");
  }
  return contract;
}

export function adapterContractHash(contract: AdapterContract): string {
  validateAdapterContract(contract);
  return sha256Text(stableJson(contract));
}

function invalidContract(why: string): never {
  throw new AdapterError(
    "ADAPTER_CONTRACT_INVALID",
    `Adapter contract ${why}.`
  );
}

function isPortableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)
  );
}

function isSemver(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)
  );
}

function isPortableRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..") &&
    !value.includes("\\")
  );
}
