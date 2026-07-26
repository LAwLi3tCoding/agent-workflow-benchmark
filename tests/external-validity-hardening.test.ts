import { describe, expect, test } from "vitest";
import {
  analyzeExternalValidity,
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

describe("external criterion validity hardening", () => {
  test("rejects duplicate labels from the same rater before establishing criterion validity", () => {
    const study = makeStudy();
    const labels = makeLabels(study);
    labels.labels.push({ ...labels.labels[0]! });

    const report = analyzeExternalValidity(study, makeObservations(study), labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("HUMAN_LABELS_INVALID");
  });

  test("rejects duplicate adjudications for the same item before establishing criterion validity", () => {
    const study = makeStudy();
    const labels = makeLabels(study);
    labels.labels[1] = {
      ...labels.labels[1]!,
      classification: "REGRESSED",
      gateDecision: "BLOCK",
      failureCodes: []
    };
    labels.adjudications.push(
      {
        itemId: study.items[0]!.itemId,
        adjudicatorId: "adjudicator-a",
        classification: "IMPROVED",
        gateDecision: "PASS",
        failureCodes: [],
        resolution: "owner_confirmed"
      },
      {
        itemId: study.items[0]!.itemId,
        adjudicatorId: "adjudicator-b",
        classification: "IMPROVED",
        gateDecision: "PASS",
        failureCodes: [],
        resolution: "duplicate_resolution"
      }
    );

    const report = analyzeExternalValidity(study, makeObservations(study), labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("HUMAN_LABELS_INVALID");
  });

  test("rejects adjudication that attempts to override two agreeing P0 labels", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const p0ItemId = study.items.find(
      (item) => item.designStratum === "p0_regression"
    )!.itemId;
    labels.adjudications.push({
      itemId: p0ItemId,
      adjudicatorId: "adjudicator-a",
      classification: "UNCHANGED",
      gateDecision: "PASS",
      failureCodes: [],
      resolution: "attempted_consensus_override"
    });

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).not.toBe("PASS");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.blockers).toContain("HUMAN_LABELS_INVALID");
    expect(report.metrics.falsePassCount).toBeNull();
  });

  test("rejects unknown failure codes even when observations and labels agree", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const itemId = study.items.find(
      (item) => item.designStratum === "no_change"
    )!.itemId;

    for (const label of labels.labels.filter((item) => item.itemId === itemId)) {
      label.failureCodes = ["NOT_A_REGISTERED_FAILURE"];
    }

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("UNKNOWN_FAILURE_CODE");
  });

  test("rejects P0 hard-failure labels that carry a PASS gate", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const p0ItemId = study.items.find(
      (item) => item.designStratum === "p0_regression"
    )!.itemId;

    for (const label of labels.labels.filter((item) => item.itemId === p0ItemId)) {
      label.gateDecision = "PASS";
    }

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("INVALID_P0_GATE_SEMANTICS");
  });

  test("rejects hard-failure observations without a registered failure code", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const itemId = study.items.find(
      (item) => item.designStratum === "no_change"
    )!.itemId;

    for (const label of labels.labels.filter((item) => item.itemId === itemId)) {
      label.classification = "HARD_FAILURE";
      label.gateDecision = "BLOCK";
      label.failureCodes = [];
    }

    const report = analyzeExternalValidity(study, observations, labels);

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("HARD_FAILURE_CODE_MISSING");
  });

  test("keeps unresolved widespread rater disagreement pending instead of failing thresholds early", () => {
    const study = makeStudy();
    const labels = makeLabels(study);
    for (const item of study.items.slice(0, 40)) {
      const second = labels.labels.find(
        (label) => label.itemId === item.itemId && label.raterId === "rater-b"
      )!;
      second.classification =
        second.classification === "IMPROVED" ? "REGRESSED" : "IMPROVED";
      second.gateDecision = second.classification === "IMPROVED" ? "PASS" : "BLOCK";
      second.failureCodes = [];
    }

    const report = analyzeExternalValidity(study, makeObservations(study), labels);

    expect(report.status).toBe("PENDING_HUMAN_INPUT");
    expect(report.criterionValidity).toBe("pending_human_input");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("UNRESOLVED_LABEL_DISAGREEMENT");
  });

  test("rejects malformed direct-API observation classifications before establishing criterion validity", () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    Object.assign(observations.items[0]!, {
      classification: "WIN" as never
    });

    const report = analyzeExternalValidity(study, observations, makeLabels(study));

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.gateEligibility).toBe("DIAGNOSTIC_ONLY");
    expect(report.blockers).toContain("AWB_OBSERVATIONS_INVALID");
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
    studyId: "external-validity-hardening",
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
