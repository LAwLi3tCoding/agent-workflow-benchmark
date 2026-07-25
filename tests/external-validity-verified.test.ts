import { beforeEach, describe, expect, test, vi } from "vitest";

const verifiedComparisons = vi.hoisted(
  () => new Map<string, Record<string, unknown>>()
);

vi.mock("../src/validity/comparisonEvidence.js", () => ({
  verifyExternalValidityComparisonEvidence: vi.fn(
    async (comparisonRef: string) =>
      verifiedComparisons.get(comparisonRef) ?? {
        status: "INVALID",
        reason: "fixture comparison is not verified"
      }
  )
}));

import {
  analyzeExternalValidityFromComparisons,
  type ExternalValidityHumanLabels,
  type ExternalValidityObservationSet,
  type ExternalValidityStudy
} from "../src/validity/externalValidity.js";

const targetClasses = ["directory", "cli", "hybrid"] as const;
const runners = ["codex", "claude"] as const;
const strata = [
  "known_improvement",
  "no_change",
  "ordinary_regression",
  "p0_regression"
] as const;

describe("verified external criterion validity", () => {
  beforeEach(() => {
    verifiedComparisons.clear();
  });

  test("establishes criterion validity only after every comparison is independently reverified", async () => {
    const study = makeStudy();
    const report = await analyzeExternalValidityFromComparisons(
      study,
      makeObservations(study),
      makeLabels(study),
      trustOptions()
    );

    expect(report).toMatchObject({
      status: "PASS",
      criterionValidity: "established",
      strongConclusionAllowed: true,
      gateEligibility: "ELIGIBLE",
      blockers: [],
      failures: [],
      metrics: {
        sampleSize: {
          planned: 120,
          observed: 120,
          labeled: 120,
          adjudicated: 0
        },
        p0Precision: 1,
        p0Recall: 1,
        falsePassCount: 0,
        overallAgreement: 1,
        interRaterAgreement: 1,
        cohenKappa: 1
      }
    });
    expect(report.metrics.confusionMatrix).toEqual(
      expect.arrayContaining([
        { expected: "IMPROVED", observed: "IMPROVED", count: 30 },
        { expected: "UNCHANGED", observed: "UNCHANGED", count: 30 },
        { expected: "REGRESSED", observed: "REGRESSED", count: 30 },
        {
          expected: "HARD_FAILURE",
          observed: "HARD_FAILURE",
          count: 30
        }
      ])
    );
  });

  test("a reverified P0 false PASS blocks regardless of aggregate agreement", async () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const p0Item = study.items.find(
      (item) => item.designStratum === "p0_regression"
    )!;
    const comparisonRef = observations.items.find(
      (item) => item.itemId === p0Item.itemId
    )!.evidence.comparisonRef;
    const verification = verifiedComparisons.get(comparisonRef)!;
    verification.evidence = {
      ...(verification.evidence as object),
      classification: "UNCHANGED",
      gateDecision: "PASS",
      failureCodes: []
    };

    const report = await analyzeExternalValidityFromComparisons(
      study,
      observations,
      makeLabels(study),
      trustOptions()
    );

    expect(report.status).toBe("FAIL");
    expect(report.gateEligibility).toBe("BLOCK");
    expect(report.metrics.falsePassCount).toBe(1);
    expect(report.metrics.p0Recall).toBeLessThan(1);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "FALSE_PASS_DETECTED",
        "P0_RECALL_BELOW_THRESHOLD"
      ])
    );
  });

  test("an adjudication cannot erase agreeing P0 truth from a reverified false PASS", async () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const labels = makeLabels(study);
    const p0Item = study.items.find(
      (item) => item.designStratum === "p0_regression"
    )!;
    const comparisonRef = observations.items.find(
      (item) => item.itemId === p0Item.itemId
    )!.evidence.comparisonRef;
    const verification = verifiedComparisons.get(comparisonRef)!;
    verification.evidence = {
      ...(verification.evidence as object),
      classification: "UNCHANGED",
      gateDecision: "PASS",
      failureCodes: []
    };
    labels.adjudications.push({
      itemId: p0Item.itemId,
      adjudicatorId: "adjudicator-a",
      classification: "UNCHANGED",
      gateDecision: "PASS",
      failureCodes: [],
      resolution: "attempted_consensus_override"
    });

    const report = await analyzeExternalValidityFromComparisons(
      study,
      observations,
      labels,
      trustOptions()
    );

    expect(report.status).toBe("FAIL");
    expect(report.blockers).toContain("HUMAN_LABELS_INVALID");
    expect(report.metrics.falsePassCount).toBe(1);
    expect(report.failures).toContain("FALSE_PASS_DETECTED");
  });

  test("a comparison that fails study bindings stays diagnostic", async () => {
    const study = makeStudy();
    const observations = makeObservations(study);
    const first = observations.items[0]!;
    const verification = verifiedComparisons.get(
      first.evidence.comparisonRef
    )!;
    verification.evidence = {
      ...(verification.evidence as object),
      runner: "claude"
    };

    const report = await analyzeExternalValidityFromComparisons(
      study,
      observations,
      makeLabels(study),
      trustOptions()
    );

    expect(report.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.strongConclusionAllowed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        "AWB_OBSERVATIONS_INCOMPLETE",
        "UNQUALIFIED_EVIDENCE"
      ])
    );
    expect(report.metrics.sampleSize.observed).toBe(119);
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
    studyId: "verified-external-validity",
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
  const targets = new Map(
    study.targets.map((target) => [target.targetId, target])
  );
  return {
    schemaVersion: "0.1.0",
    resultType: "external_validity_observations",
    studyId: study.studyId,
    status: "COMPLETE",
    items: study.items.map((item, index) => {
      const comparisonRef = `comparison://${item.itemId}`;
      const comparisonHash = hash(`comparison-${index}`);
      const decision = expectedDecision(item.designStratum);
      verifiedComparisons.set(comparisonRef, {
        status: "VALID",
        evidence: {
          ...decision,
          comparisonHash,
          targetIdHash: targets.get(item.targetId)!.targetRefHash,
          contractHash: targets.get(item.targetId)!.contractHash,
          runner: item.runner,
          baselineContentHash: item.baseline.contentHash,
          candidateContentHash: item.candidate.contentHash,
          attemptFingerprint: hash(`attempt-${index}`)
        }
      });
      return {
        itemId: item.itemId,
        evidence: {
          comparisonRef,
          comparisonHash
        }
      };
    })
  };
}

function makeLabels(study: ExternalValidityStudy): ExternalValidityHumanLabels {
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

function expectedDecision(stratum: (typeof strata)[number]) {
  switch (stratum) {
    case "known_improvement":
      return {
        classification: "IMPROVED" as const,
        gateDecision: "PASS" as const,
        failureCodes: []
      };
    case "no_change":
      return {
        classification: "UNCHANGED" as const,
        gateDecision: "PASS" as const,
        failureCodes: []
      };
    case "ordinary_regression":
      return {
        classification: "REGRESSED" as const,
        gateDecision: "BLOCK" as const,
        failureCodes: []
      };
    case "p0_regression":
      return {
        classification: "HARD_FAILURE" as const,
        gateDecision: "BLOCK" as const,
        failureCodes: ["TARGET_ROUTE_FORBIDDEN"]
      };
  }
}

function trustOptions() {
  return {
    trustedObserverKeyPath: "observer-public.pem",
    trustedQualificationKeyPath: "qualification-authority-public.pem"
  };
}

function hash(value: string): string {
  return `sha256:${Buffer.from(value)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64)}`;
}
