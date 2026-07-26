import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ValidateFunction } from "ajv/dist/2020.js";
import YAML from "yaml";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
import { createAjv2020 } from "../utils/jsonSchema.js";
import type {
  ExternalValidityHumanLabels,
  ExternalValidityLabelingPackage,
  ExternalValidityObservationSet,
  ExternalValidityReport,
  ExternalValidityStudy
} from "./externalValidity.js";

const validators = new Map<string, ValidateFunction>();

export async function loadExternalValidityStudy(
  filePath: string
): Promise<ExternalValidityStudy> {
  const value = await readStructured(filePath);
  await assertExternalValiditySchema(
    "external-validity-study.schema.json",
    value,
    "External validity study"
  );
  return value as ExternalValidityStudy;
}

export async function loadExternalValidityObservations(
  filePath: string
): Promise<ExternalValidityObservationSet> {
  const value = await readStructured(filePath);
  await assertExternalValiditySchema(
    "external-validity-observations.schema.json",
    value,
    "External validity observations"
  );
  const observations = value as ExternalValidityObservationSet;
  const inputRoot = path.dirname(path.resolve(filePath));
  return {
    ...observations,
    items: observations.items.map((item) => ({
      ...item,
      evidence: {
        ...item.evidence,
        comparisonRef: path.isAbsolute(item.evidence.comparisonRef)
          ? item.evidence.comparisonRef
          : path.resolve(inputRoot, item.evidence.comparisonRef)
      }
    }))
  };
}

export async function loadExternalValidityHumanLabels(
  filePath: string
): Promise<ExternalValidityHumanLabels> {
  const value = await readStructured(filePath);
  await assertExternalValiditySchema(
    "external-validity-human-labels.schema.json",
    value,
    "External validity human labels"
  );
  return value as ExternalValidityHumanLabels;
}

export async function validateExternalValidityPackage(
  artifacts: ExternalValidityLabelingPackage
): Promise<void> {
  await Promise.all([
    assertExternalValiditySchema(
      "external-validity-labeling-package.schema.json",
      artifacts.package,
      "External validity labeling package"
    ),
    assertExternalValiditySchema(
      "external-validity-observations.schema.json",
      artifacts.observationsTemplate,
      "External validity observations template"
    ),
    assertExternalValiditySchema(
      "external-validity-human-labels.schema.json",
      artifacts.labelsTemplate,
      "External validity human-label template"
    ),
    ...artifacts.agentPrelabelTemplates.map((template) =>
      assertExternalValiditySchema(
        "external-validity-agent-prelabels.schema.json",
        template,
        "External validity agent-prelabel template"
      )
    )
  ]);
}

export async function validateExternalValidityReport(
  report: ExternalValidityReport
): Promise<void> {
  await assertExternalValiditySchema(
    "validity-report.schema.json",
    report,
    "External validity report"
  );
}

export async function assertExternalValiditySchema(
  schemaName: string,
  value: unknown,
  label: string
): Promise<void> {
  let validate = validators.get(schemaName);
  if (!validate) {
    const schema = JSON.parse(
      await readFile(
        path.join(getBenchmarkRoot(), "schemas", schemaName),
        "utf8"
      )
    ) as object;
    validate = createAjv2020().compile(schema);
    validators.set(schemaName, validate);
  }
  if (!validate(value)) {
    throw new Error(
      `${label} failed schema validation: ${createAjv2020().errorsText(
        validate.errors
      )}`
    );
  }
}

async function readStructured(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return YAML.parse(text) as unknown;
  }
  return JSON.parse(text) as unknown;
}
