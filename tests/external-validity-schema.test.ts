import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import YAML from "yaml";
import {
  analyzeExternalValidity,
  createExternalValidityLabelingPackage,
  type ExternalValidityHumanLabels,
  type ExternalValidityObservationSet,
  type ExternalValidityStudy
} from "../src/validity/externalValidity.js";

const cwd = process.cwd();
const schemaNames = [
  "external-validity-study.schema.json",
  "external-validity-labeling-package.schema.json",
  "external-validity-observations.schema.json",
  "external-validity-human-labels.schema.json",
  "validity-report.schema.json"
] as const;

describe("external validity schemas", () => {
  test("compile all external validity schemas", async () => {
    const ajv = new Ajv2020({ strict: false });

    for (const schemaName of schemaNames) {
      const schema = await readSchema(schemaName);
      expect(() => ajv.compile(schema), schemaName).not.toThrow();
    }
  });

  test("validate fixture study and generated package, templates, and report", async () => {
    const validators = await compileSchemas();
    const study = await readFixtureStudy();
    const artifacts = createExternalValidityLabelingPackage(study);
    const report = analyzeExternalValidity(study);

    expect(validators.study(study), JSON.stringify(validators.study.errors)).toBe(true);
    expect(
      validators.labelingPackage(artifacts.package),
      JSON.stringify(validators.labelingPackage.errors)
    ).toBe(true);
    expect(
      validators.observations(artifacts.observationsTemplate),
      JSON.stringify(validators.observations.errors)
    ).toBe(true);
    expect(
      validators.humanLabels(artifacts.labelsTemplate),
      JSON.stringify(validators.humanLabels.errors)
    ).toBe(true);
    expect(validators.report(report), JSON.stringify(validators.report.errors)).toBe(true);
  });

  test("reject extra properties and private artifact refs", async () => {
    const validators = await compileSchemas();
    const study = await readFixtureStudy();
    const artifacts = createExternalValidityLabelingPackage(study);

    expect(validators.study({ ...study, outputPath: "tmp/report.json" })).toBe(false);
    expect(
      validators.labelingPackage({
        ...artifacts.package,
        items: [
          {
            ...artifacts.package.items[0],
            baseline: {
              ...artifacts.package.items[0]!.baseline,
              ref: ["/", "Users", "/", "private", "/", "run"].join("")
            }
          }
        ]
      })
    ).toBe(false);
    expect(
      validators.labelingPackage({
        ...artifacts.package,
        items: [
          {
            ...artifacts.package.items[0],
            candidate: {
              ...artifacts.package.items[0]!.candidate,
              ref: "https://example.com/user@example.com/run"
            }
          }
        ]
      })
    ).toBe(false);
  });

  test("enforce COMPLETE document requirements without rejecting DRAFT templates", async () => {
    const validators = await compileSchemas();
    const study = makeCompleteStudy();
    const observations = makeCompleteObservations(study);
    const labels = makeCompleteLabels(study);
    const templates = createExternalValidityLabelingPackage(study);

    expect(validators.observations(templates.observationsTemplate)).toBe(true);
    expect(validators.humanLabels(templates.labelsTemplate)).toBe(true);
    expect(validators.observations(observations)).toBe(true);
    expect(validators.humanLabels(labels)).toBe(true);

    expect(
      validators.observations({
        ...observations,
        items: []
      })
    ).toBe(false);
    expect(
      validators.observations({
        ...observations,
        items: [
          {
            ...observations.items[0],
            evidence: {
              provenanceStatus: "VALID",
              executionMode: "live",
              evidenceKind: "live",
              observationLevel: "workflow_trace",
              observerQualificationStatus: "valid"
            }
          }
        ]
      })
    ).toBe(false);
    expect(
      validators.humanLabels({
        ...labels,
        blindingAttestation: undefined
      })
    ).toBe(false);
    expect(
      validators.humanLabels({
        ...labels,
        labels: []
      })
    ).toBe(false);
  });

  test("requires comparison-bundle evidence instead of self-attested trust fields", async () => {
    const validators = await compileSchemas();
    const study = makeCompleteStudy();
    const comparisonBacked = makeCompleteObservations(study);
    const selfAttested = {
      ...comparisonBacked,
      items: [
        {
          itemId: study.items[0]!.itemId,
          classification: "HARD_FAILURE",
          gateDecision: "BLOCK",
          failureCodes: ["TARGET_ROUTE_FORBIDDEN"],
          evidence: {
            provenanceStatus: "VALID",
            executionMode: "live",
            evidenceKind: "live",
            observationLevel: "workflow_trace",
            observerQualificationStatus: "valid",
            traceHash: hash("trace"),
            attemptFingerprint: hash("attempt")
          }
        }
      ]
    };

    expect(
      validators.observations(comparisonBacked),
      JSON.stringify(validators.observations.errors)
    ).toBe(true);
    expect(validators.observations(selfAttested)).toBe(false);
  });

  test("require reviewed contract-review hashes and validate report integrity shape", async () => {
    const validators = await compileSchemas();
    const study = makeCompleteStudy();
    const report = analyzeExternalValidity(
      study,
      makeCompleteObservations(study),
      makeCompleteLabels(study)
    );

    expect(validators.study(study), JSON.stringify(validators.study.errors)).toBe(true);
    expect(
      validators.study({
        ...study,
        targets: [
          {
            ...study.targets[0],
            contractReview: { status: "reviewed" }
          }
        ]
      })
    ).toBe(false);
    expect(validators.report(report), JSON.stringify(validators.report.errors)).toBe(true);
    expect(report.integrity.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(validators.report({ ...report, integrity: { status: "PENDING" } })).toBe(false);
  });
});

async function compileSchemas() {
  return {
    study: await compileSchema("external-validity-study.schema.json"),
    labelingPackage: await compileSchema(
      "external-validity-labeling-package.schema.json"
    ),
    observations: await compileSchema("external-validity-observations.schema.json"),
    humanLabels: await compileSchema("external-validity-human-labels.schema.json"),
    report: await compileSchema("validity-report.schema.json")
  };
}

async function compileSchema(file: string) {
  return new Ajv2020({ strict: false }).compile(await readSchema(file));
}

async function readSchema(file: string) {
  return JSON.parse(await readFile(path.join(cwd, "schemas", file), "utf8")) as object;
}

async function readFixtureStudy(): Promise<ExternalValidityStudy> {
  const text = await readFile(
    path.join(cwd, "fixtures", "external-validity", "v1", "study.yaml"),
    "utf8"
  );
  return YAML.parse(text) as ExternalValidityStudy;
}

function makeCompleteStudy(): ExternalValidityStudy {
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_study",
    studyId: "complete-schema-study",
    protocolVersion: "criterion-validity-v1",
    blinding: {
      mode: "double_blind",
      assignmentHash: hash("assignment")
    },
    targets: [
      {
        targetId: "target-directory",
        blindedTargetId: "target-1",
        targetClass: "directory",
        targetRefHash: hash("target"),
        contractHash: hash("contract"),
        contractReview: {
          status: "reviewed",
          artifactHash: hash("contract-review")
        }
      }
    ],
    items: [
      {
        itemId: "item-1",
        blindedChangeId: "change-1",
        targetId: "target-directory",
        runner: "codex",
        runnerBlindId: "runner-a",
        designStratum: "p0_regression",
        baseline: {
          ref: "external://item-1-baseline",
          contentHash: hash("baseline")
        },
        candidate: {
          ref: "external://item-1-candidate",
          contentHash: hash("candidate")
        }
      }
    ]
  };
}

function makeCompleteObservations(
  study: ExternalValidityStudy
): ExternalValidityObservationSet {
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_observations",
    studyId: study.studyId,
    status: "COMPLETE",
    items: study.items.map((item) => ({
      itemId: item.itemId,
      evidence: {
        comparisonRef: `comparisons/${item.itemId}/comparison-result.json`,
        comparisonHash: hash(`comparison-${item.itemId}`)
      }
    }))
  };
}

function makeCompleteLabels(study: ExternalValidityStudy): ExternalValidityHumanLabels {
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_human_labels",
    studyId: study.studyId,
    status: "COMPLETE",
    blindingAttestation: "awb_decision_hidden",
    raters: [
      { raterId: "rater-a", role: "workflow_owner" },
      { raterId: "rater-b", role: "independent_reviewer" }
    ],
    labels: study.items.flatMap((item) => [
      {
        itemId: item.itemId,
        raterId: "rater-a",
        classification: "HARD_FAILURE" as const,
        gateDecision: "BLOCK" as const,
        failureCodes: ["TARGET_P0"]
      },
      {
        itemId: item.itemId,
        raterId: "rater-b",
        classification: "HARD_FAILURE" as const,
        gateDecision: "BLOCK" as const,
        failureCodes: ["TARGET_P0"]
      }
    ]),
    adjudications: []
  };
}

function hash(value: string): string {
  return `sha256:${Buffer.from(value)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64)}`;
}
