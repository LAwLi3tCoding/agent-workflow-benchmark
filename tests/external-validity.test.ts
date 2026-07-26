import { describe, expect, test } from "vitest";
import {
  analyzeExternalValidity,
  createExternalValidityLabelingPackage,
  type ExternalValidityHumanLabels,
  type ExternalValidityObservationSet,
  type ExternalValidityStudy
} from "../src/validity/externalValidity.js";
import { humanConfirmationMetadata } from "./helpers/humanLabels.js";

const hash = (value: string): string =>
  `sha256:${Buffer.from(value)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64)}`;

const targetClasses = ["directory", "cli", "hybrid"] as const;
const runners = ["codex", "claude"] as const;
const strata = [
  "known_improvement",
  "no_change",
  "ordinary_regression",
  "p0_regression"
] as const;

describe("external criterion validity", () => {
  test("creates a blinded, public-safe labeling package without leaking design or AWB outcomes", () => {
    const study = makeStudy();
    const result = createExternalValidityLabelingPackage(study);
    const serialized = JSON.stringify(result);

    expect(result.package.status).toBe("READY_FOR_HUMAN_LABELING");
    expect(result.package.publicSafe).toBe(true);
    expect(result.package.items).toHaveLength(120);
    expect(new Set(result.package.items.map((item) => item.targetClass))).toEqual(
      new Set(targetClasses)
    );
    expect(serialized).not.toMatch(
      /known_improvement|no_change|ordinary_regression|p0_regression/u
    );
    expect(serialized).not.toMatch(
      /"runner":"codex"|"runner":"claude"|classification|gateDecision|failureCodes/u
    );
    expect(serialized).not.toMatch(
      new RegExp(
        [
          "\\/",
          "Users",
          "\\/|@|",
          ["private", "target"].join("-"),
          "|",
          ["company", "domain"].join("-")
        ].join(""),
        "iu"
      )
    );
    expect(result.labelsTemplate).toMatchObject({
      status: "DRAFT",
      labels: [],
      adjudications: []
    });
    expect(result.observationsTemplate).toMatchObject({
      status: "DRAFT",
      items: []
    });
    expect(result.agentPrelabelTemplates).toHaveLength(2);
    expect(result.agentPrelabelTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resultType: "external_validity_agent_prelabels",
          source: "agent_assisted_draft",
          humanTruth: false,
          awbDecisionVisible: false,
          laneId: "agent-rater-a"
        }),
        expect.objectContaining({
          resultType: "external_validity_agent_prelabels",
          source: "agent_assisted_draft",
          humanTruth: false,
          awbDecisionVisible: false,
          laneId: "agent-rater-b"
        })
      ])
    );
  });

  test("keeps agent-assisted labels pending until both human confirmations are externally evidenced", () => {
    const study = makeStudy();
    const labels = makeLabels(study);
    delete labels.raters[0]!.confirmation;

    const report = analyzeExternalValidity(
      study,
      makeObservations(study),
      labels
    );

    expect(report).toMatchObject({
      status: "PENDING_HUMAN_INPUT",
      criterionValidity: "pending_human_input",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY",
      blockers: expect.arrayContaining([
        "HUMAN_CONFIRMATION_EVIDENCE_MISSING"
      ])
    });
  });

  test("emits a complete pending-human-input report when labels and observations are absent", () => {
    const report = analyzeExternalValidity(makeStudy());

    expect(report).toMatchObject({
      status: "PENDING_HUMAN_INPUT",
      criterionValidity: "pending_human_input",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY",
      blockers: expect.arrayContaining([
        "AWB_OBSERVATIONS_MISSING",
        "HUMAN_LABELS_MISSING"
      ]),
      metrics: {
        sampleSize: {
          planned: 120,
          observed: 0,
          labeled: 0,
          adjudicated: 0
        },
        confusionMatrix: [],
        p0Precision: null,
        p0Recall: null,
        falsePassCount: null,
        overallAgreement: null,
        interRaterAgreement: null,
        cohenKappa: null
      },
      integrity: {
        status: "VERIFIED_AT_WRITE",
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
  });

  test("binds the report to the frozen policy and every input surface", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const report = analyzeExternalValidity(study, observations, labels);

    expect(report).toMatchObject({
      bindings: {
        policyHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        studyHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        observationsHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        verifiedEvidenceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        humanLabelsHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });

    labels.labels[0]!.classification = "REGRESSED";
    labels.labels[0]!.gateDecision = "BLOCK";
    const changed = analyzeExternalValidity(study, observations, labels);
    const firstBindings = (
      report as typeof report & { bindings: { humanLabelsHash: string } }
    ).bindings;
    const changedBindings = (
      changed as typeof changed & { bindings: { humanLabelsHash: string } }
    ).bindings;
    expect(changedBindings.humanLabelsHash).not.toBe(
      firstBindings.humanLabelsHash
    );
    expect(changed.integrity.contentHash).not.toBe(
      report.integrity.contentHash
    );
  });

  test("does not trust a hand-authored observation manifest as qualified evidence", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const report = analyzeExternalValidity(study, observations, labels);

    expect(report).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      criterionValidity: "diagnostic_only",
      strongConclusionAllowed: false,
      gateEligibility: "DIAGNOSTIC_ONLY",
      blockers: expect.arrayContaining([
        "AWB_OBSERVATIONS_INCOMPLETE",
        "UNQUALIFIED_EVIDENCE"
      ]),
      failures: [],
      metrics: {
        sampleSize: {
          planned: 120,
          observed: 0,
          labeled: 120,
          adjudicated: 0
        },
        p0Precision: null,
        p0Recall: null,
        falsePassCount: null,
        overallAgreement: null,
        interRaterAgreement: 1,
        cohenKappa: 1
      },
      coverage: {
        targetClasses: ["cli", "directory", "hybrid"],
        runners: ["claude", "codex"],
        designCells: 24,
        minimumItemsPerCell: 5,
        complete: true
      }
    });
    expect(report.metrics.confusionMatrix).toEqual([]);
  });

  test("accepts human labels keyed by the blinded change ids emitted in the labeling package", () => {
    const study = makeStudy();
    const labels = makeLabels(study);
    const blindedIds = new Map(
      study.items.map((item) => [item.itemId, item.blindedChangeId])
    );
    for (const label of labels.labels) {
      label.itemId = blindedIds.get(label.itemId)!;
    }

    const report = analyzeExternalValidity(
      study,
      makeObservations(study),
      labels
    );

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.blockers).not.toContain("HUMAN_LABELS_INVALID");
    expect(report.blockers).toContain("UNQUALIFIED_EVIDENCE");
    expect(report.metrics.sampleSize.labeled).toBe(120);
  });

  test("rejects self-attested decision fields added to an observation manifest", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    Object.assign(observations.items[0]!, {
      classification: "UNCHANGED",
      gateDecision: "PASS",
      failureCodes: []
    });

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("AWB_OBSERVATIONS_INVALID");
    expect(report.metrics.falsePassCount).toBeNull();
  });

  test("unverified comparison references remain diagnostic", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.criterionValidity).toBe("diagnostic_only");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("UNQUALIFIED_EVIDENCE");
  });

  test("replayed signed evidence cannot inflate the external-validity sample", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    observations.items[1]!.evidence.comparisonHash =
      observations.items[0]!.evidence.comparisonHash;

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("DUPLICATE_EVIDENCE");
  });

  test("cannot establish P0 recall without an independent P0 reference label", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const p0ItemIds = new Set(
      study.items
        .filter((item) => item.designStratum === "p0_regression")
        .map((item) => item.itemId)
    );
    for (const label of labels.labels) {
      if (p0ItemIds.has(label.itemId)) {
        label.classification = "REGRESSED";
        label.gateDecision = "BLOCK";
        label.failureCodes = [];
      }
    }

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.blockers).toContain("P0_REFERENCE_LABEL_MISSING");
    expect(report.strongConclusionAllowed).toBe(false);
  });

  test("unresolved rater disagreement stays pending instead of manufacturing truth", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    labels.labels[1]!.classification = "REGRESSED";
    labels.labels[1]!.gateDecision = "BLOCK";

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("PENDING_HUMAN_INPUT");
    expect(report.criterionValidity).toBe("pending_human_input");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.blockers).toContain("UNRESOLVED_LABEL_DISAGREEMENT");
  });

  test("low inter-rater kappa fails even after every disagreement is adjudicated", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    for (const item of study.items.slice(0, 30)) {
      const second = labels.labels.find(
        (label) =>
          label.itemId === item.itemId && label.raterId === "rater-b"
      )!;
      second.classification =
        second.classification === "IMPROVED" ? "REGRESSED" : "IMPROVED";
      second.gateDecision =
        second.classification === "IMPROVED" ? "PASS" : "BLOCK";
      second.failureCodes = [];
      const first = labels.labels.find(
        (label) =>
          label.itemId === item.itemId && label.raterId === "rater-a"
      )!;
      labels.adjudications.push({
        itemId: item.itemId,
        adjudicatorId: "adjudicator-a",
        classification: first.classification,
        gateDecision: first.gateDecision,
        failureCodes: first.failureCodes,
        resolution: "independent_adjudication"
      });
    }

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("FAIL");
    expect(report.metrics.overallAgreement).toBeNull();
    expect(report.metrics.cohenKappa).toBeLessThan(0.8);
    expect(report.failures).toContain("COHEN_KAPPA_BELOW_THRESHOLD");
  });

  test("rejects non-public artifact references before creating a label package", () => {
    const study = makeStudy();
    study.items[0]!.baseline.ref = [
      "/",
      "Users",
      "/",
      "private",
      "/",
      "target-run"
    ].join("");

    expect(() => createExternalValidityLabelingPackage(study)).toThrow(
      "public-safe external artifact references"
    );
  });
});

function makeStudy(): ExternalValidityStudy {
  const targets = targetClasses.map((targetClass, index) => ({
    targetId: `external-target-${targetClass}`,
    blindedTargetId: `target-${index + 1}`,
    targetClass,
    targetRefHash: hash(`target-${targetClass}`),
    contractHash: hash(`contract-${targetClass}`),
    contractReview: {
      status: "reviewed" as const,
      artifactHash: hash(`review-${targetClass}`)
    }
  }));
  const items: ExternalValidityStudy["items"] = [];
  for (const target of targets) {
    for (const runner of runners) {
      for (const designStratum of strata) {
        for (let index = 1; index <= 5; index += 1) {
          const itemId = [
            target.targetClass,
            runner,
            designStratum,
            String(index).padStart(2, "0")
          ].join("-");
          items.push({
            itemId,
            blindedChangeId: `change-${String(items.length + 1).padStart(3, "0")}`,
            targetId: target.targetId,
            runner,
            runnerBlindId: runner === "codex" ? "runner-a" : "runner-b",
            designStratum,
            baseline: {
              ref: `external://baseline-${itemId}`,
              contentHash: hash(`baseline-${itemId}`)
            },
            candidate: {
              ref: `external://candidate-${itemId}`,
              contentHash: hash(`candidate-${itemId}`)
            }
          });
        }
      }
    }
  }
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_study",
    studyId: "external-validity-fixture",
    protocolVersion: "criterion-validity-v1",
    blinding: {
      mode: "double_blind",
      assignmentHash: hash("assignment")
    },
    targets,
    items
  };
}

function makeObservations(
  study: ExternalValidityStudy
): ExternalValidityObservationSet {
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_observations",
    studyId: study.studyId,
    status: "COMPLETE",
    items: study.items.map((item, index) => ({
      itemId: item.itemId,
      evidence: {
        comparisonRef: `comparisons/${item.itemId}/comparison-result.json`,
        comparisonHash: hash(`comparison-${index}`)
      }
    }))
  };
}

function makeLabels(study: ExternalValidityStudy): ExternalValidityHumanLabels {
  return {
    ...humanConfirmationMetadata(),
    schemaVersion: "0.1.0",
    resultType: "external_validity_human_labels",
    studyId: study.studyId,
    status: "COMPLETE",
    blindingAttestation: "awb_decision_hidden",
    labels: study.items.flatMap((item) => {
      const decision = expectedDecision(item.designStratum);
      return ["rater-a", "rater-b"].map((raterId) => ({
        itemId: item.itemId,
        raterId,
        classification: decision.classification,
        gateDecision: decision.gateDecision,
        failureCodes: decision.failureCodes
      }));
    }),
    adjudications: []
  };
}

function expectedDecision(
  stratum: (typeof strata)[number]
): {
  classification: "IMPROVED" | "UNCHANGED" | "REGRESSED" | "HARD_FAILURE";
  gateDecision: "PASS" | "BLOCK";
  failureCodes: string[];
} {
  switch (stratum) {
    case "known_improvement":
      return {
        classification: "IMPROVED",
        gateDecision: "PASS",
        failureCodes: []
      };
    case "no_change":
      return {
        classification: "UNCHANGED",
        gateDecision: "PASS",
        failureCodes: []
      };
    case "ordinary_regression":
      return {
        classification: "REGRESSED",
        gateDecision: "BLOCK",
        failureCodes: []
      };
    case "p0_regression":
      return {
        classification: "HARD_FAILURE",
        gateDecision: "BLOCK",
        failureCodes: ["TARGET_ROUTE_FORBIDDEN"]
      };
  }
}
