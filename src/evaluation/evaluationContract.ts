import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getBenchmarkRoot } from "../core/targetRegistry.js";

export type EvaluationContractStatus = "implemented" | "backlog";

export interface EvaluationContract {
  schemaVersion: "0.1.0";
  contractId: "agent-workflow-bench-evaluation-contract";
  models: {
    targetPack: {
      status: "implemented";
      definitionRef: string;
      implementationRef: string;
    };
    contractModel: {
      status: "implemented";
      definitionRef: string;
      implementationRef: string;
      formalSchemaStatus: "backlog";
    };
  };
  evidencePolicy: {
    truePassRequires: {
      evidenceKind: "live";
      observationLevel: "workflow_trace";
      observerQualification: "valid";
    };
    diagnosticOnlyObservationLevels: string[];
  };
  scorePolicy: {
    hardFailurePrecedence: true;
    p0ScoreCap: number;
    casePassMinimum: number;
    caseConditionalMinimum: number;
    suiteApproveMinimum: number;
    suiteConditionalMinimum: number;
    telemetryMinimum: number;
    efficiencyWastedRatioWarning: number;
  };
  coverageTargets: Array<{
    id: string;
    label: string;
    status: EvaluationContractStatus;
  }>;
  events: Array<{
    id: string;
    status: EvaluationContractStatus;
  }>;
  oracles: Array<{
    id: string;
    templateId: string;
    title: string;
    expectedHardFailures: string[];
    status: EvaluationContractStatus;
  }>;
  hardFailures: Array<{
    code: string;
    severity: "P0" | "P1";
    dimension: string;
    source: "event" | "derived" | "comparison";
    status: EvaluationContractStatus;
    why: string;
  }>;
  dimensions: Array<{
    id: string;
    status: EvaluationContractStatus;
    weight: number;
  }>;
  comparisonClassifications: Array<{
    id: string;
    status: EvaluationContractStatus;
  }>;
  gateRules: Array<{
    id: string;
    status: EvaluationContractStatus;
  }>;
  claims: Array<{
    id: string;
    status: EvaluationContractStatus;
    contractFields: string[];
    caseTemplateIds: string[];
    eventTypes: string[];
    oracleIds: string[];
    scoreDimensions: string[];
    gateRuleIds: string[];
    tests: string[];
  }>;
}

let cachedContract: EvaluationContract | undefined;

export function getEvaluationContract(): EvaluationContract {
  if (!cachedContract) {
    const configPath = path.join(
      getBenchmarkRoot(),
      "configs/evaluation/evaluation-contract.yaml"
    );
    cachedContract = YAML.parse(readFileSync(configPath, "utf8")) as EvaluationContract;
    assertEvaluationContract(cachedContract);
  }
  return cachedContract;
}

export function getImplementedEventIds(): string[] {
  return implementedIds(getEvaluationContract().events);
}

export function getImplementedCoverageTargets(): EvaluationContract["coverageTargets"] {
  return getEvaluationContract().coverageTargets.filter(
    (item) => item.status === "implemented"
  );
}

export function getImplementedOracles(): EvaluationContract["oracles"] {
  return getEvaluationContract().oracles.filter((item) => item.status === "implemented");
}

export function getImplementedDimensions(): EvaluationContract["dimensions"] {
  return getEvaluationContract().dimensions.filter(
    (item) => item.status === "implemented"
  );
}

export function getScorePolicy(): EvaluationContract["scorePolicy"] {
  return getEvaluationContract().scorePolicy;
}

export function getHardFailureDefinition(
  code: string
): EvaluationContract["hardFailures"][number] | undefined {
  return getEvaluationContract().hardFailures.find(
    (item) => item.code === code && item.status === "implemented"
  );
}

function implementedIds(items: Array<{ id: string; status: EvaluationContractStatus }>): string[] {
  return items.filter((item) => item.status === "implemented").map((item) => item.id);
}

function assertEvaluationContract(contract: EvaluationContract): void {
  if (
    !contract ||
    contract.schemaVersion !== "0.1.0" ||
    contract.contractId !== "agent-workflow-bench-evaluation-contract"
  ) {
    throw new Error("Canonical evaluation contract is missing or unsupported.");
  }
  for (const [label, ids] of [
    ["event", contract.events.map((item) => item.id)],
    ["oracle", contract.oracles.map((item) => item.id)],
    ["hard failure", contract.hardFailures.map((item) => item.code)],
    ["dimension", contract.dimensions.map((item) => item.id)],
    ["comparison", contract.comparisonClassifications.map((item) => item.id)],
    ["gate rule", contract.gateRules.map((item) => item.id)],
    ["claim", contract.claims.map((item) => item.id)]
  ] as const) {
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
      throw new Error(`Canonical evaluation contract contains duplicate or empty ${label} ids.`);
    }
  }
}
