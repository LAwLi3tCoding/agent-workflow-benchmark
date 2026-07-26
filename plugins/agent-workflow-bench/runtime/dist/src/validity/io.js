import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import YAML from "yaml";
import { getBenchmarkRoot } from "../core/targetRegistry.js";
const validators = new Map();
export async function loadExternalValidityStudy(filePath) {
    const value = await readStructured(filePath);
    await assertExternalValiditySchema("external-validity-study.schema.json", value, "External validity study");
    return value;
}
export async function loadExternalValidityObservations(filePath) {
    const value = await readStructured(filePath);
    await assertExternalValiditySchema("external-validity-observations.schema.json", value, "External validity observations");
    const observations = value;
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
export async function loadExternalValidityHumanLabels(filePath) {
    const value = await readStructured(filePath);
    await assertExternalValiditySchema("external-validity-human-labels.schema.json", value, "External validity human labels");
    return value;
}
export async function validateExternalValidityPackage(artifacts) {
    await Promise.all([
        assertExternalValiditySchema("external-validity-labeling-package.schema.json", artifacts.package, "External validity labeling package"),
        assertExternalValiditySchema("external-validity-observations.schema.json", artifacts.observationsTemplate, "External validity observations template"),
        assertExternalValiditySchema("external-validity-human-labels.schema.json", artifacts.labelsTemplate, "External validity human-label template"),
        ...artifacts.agentPrelabelTemplates.map((template) => assertExternalValiditySchema("external-validity-agent-prelabels.schema.json", template, "External validity agent-prelabel template"))
    ]);
}
export async function validateExternalValidityReport(report) {
    await assertExternalValiditySchema("validity-report.schema.json", report, "External validity report");
}
export async function assertExternalValiditySchema(schemaName, value, label) {
    let validate = validators.get(schemaName);
    if (!validate) {
        const schema = JSON.parse(await readFile(path.join(getBenchmarkRoot(), "schemas", schemaName), "utf8"));
        validate = new Ajv2020({ strict: false }).compile(schema);
        validators.set(schemaName, validate);
    }
    if (!validate(value)) {
        throw new Error(`${label} failed schema validation: ${new Ajv2020({
            strict: false
        }).errorsText(validate.errors)}`);
    }
}
async function readStructured(filePath) {
    const text = await readFile(filePath, "utf8");
    if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
        return YAML.parse(text);
    }
    return JSON.parse(text);
}
