import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { buildTraceDiff, assertTraceDiffIntegrity } from "../src/report/traceDiff.js";
import {
  assertTrajectoryReviewIntegrity,
  buildTrajectoryReview,
  renderTrajectoryReviewMarkdown,
  type HumanTrajectoryLabels,
  type JudgeTrajectoryFindings
} from "../src/report/trajectoryReview.js";
import type { RunEvent } from "../src/core/types.js";
import { sha256Text, stableJson } from "../src/utils/hash.js";
import { createAjv2020 } from "../src/utils/jsonSchema.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

let tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("trajectory review", () => {
  test("rejects tampered trace-diff integrity before reviewing trajectories", () => {
    const traceDiff = baselineCandidateTraceDiff();
    expect(() => assertTraceDiffIntegrity(traceDiff)).not.toThrow();
    const tampered = structuredClone(traceDiff);
    tampered.integrity.sourceTraceHashes = [HASH_A, HASH_B];

    expect(() =>
      buildTrajectoryReview({
        traceDiff: tampered,
        traceDiffRef: "trace-diff.json",
        traceDiffHash: sha256Text(stableJson(tampered))
      })
    ).toThrow(/trace diff integrity/i);
  });

  test("keeps deterministic findings diagnostic and impossible for judge findings to override", () => {
    const traceDiff = baselineCandidateTraceDiff();
    const judge: JudgeTrajectoryFindings = {
      model: "judge-model",
      promptHash: HASH_A,
      rubricHash: HASH_B,
      calibrationSetIdentity: "calibration:v1",
      findings: [
        {
          findingId: "judge-benign",
          defectClass: "route_integrity",
          severity: "info",
          verdict: "not_a_defect",
          evidenceRefs: ["candidate:workflow-trace.json#event=c-failure"],
          rationale: "Judge thinks the hard failure is acceptable."
        }
      ]
    };

    const review = buildTrajectoryReview({
      traceDiff,
      traceDiffRef: "trace-diff.json",
      traceDiffHash: sha256Text(stableJson(traceDiff)),
      judgeFindings: judge
    });

    expect(review.artifactType).toBe("trajectory_review");
    expect(review.status).toBe("DIAGNOSTIC_ONLY");
    expect(review.gateAuthority).toBe("NONE");
    expect(review.validation.status).toBe("UNVALIDATED");
    expect(review.deterministicFindings).toHaveLength(1);
    expect(review.deterministicFindings[0]).toMatchObject({
      defectClass: "route_integrity",
      failureCode: "TARGET_ROUTE_FORBIDDEN",
      severity: "P0",
      direction: "added",
      onset: {
        step: 1,
        ref: "candidate:workflow-trace.json#event=c-route"
      },
      detection: {
        step: 2,
        ref: "candidate:workflow-trace.json#event=c-failure",
        latencySteps: 1
      },
      finalOutcome: "regressed"
    });
    expect(review.judgeFindings?.findings).toHaveLength(1);
    expect(review.deterministicFindings[0].findingId).not.toBe("judge-benign");
    assertTrajectoryReviewIntegrity(review);
  });

  test("rejects judge findings that cite no trace-diff event ref", () => {
    const traceDiff = baselineCandidateTraceDiff();

    expect(() =>
      buildTrajectoryReview({
        traceDiff,
        traceDiffRef: "trace-diff.json",
        traceDiffHash: sha256Text(stableJson(traceDiff)),
        judgeFindings: {
          model: "judge-model",
          promptHash: HASH_A,
          rubricHash: HASH_B,
          calibrationSetIdentity: "calibration:v1",
          findings: [
            {
              findingId: "judge-forged",
              defectClass: "route_integrity",
              severity: "high",
              verdict: "defect",
              evidenceRefs: ["candidate:workflow-trace.json#event=missing"],
              rationale: "No grounding."
            }
          ]
        }
      })
    ).toThrow(/unknown trajectory event ref/i);
  });

  test("computes judge precision and recall by class from complete blinded labels", () => {
    const traceDiff = baselineCandidateTraceDiff();
    const judge: JudgeTrajectoryFindings = {
      model: "judge-model",
      promptHash: HASH_A,
      rubricHash: HASH_B,
      calibrationSetIdentity: "calibration:v1",
      findings: [
        {
          findingId: "judge-route",
          defectClass: "route_integrity",
          severity: "high",
          verdict: "defect",
          evidenceRefs: ["candidate:workflow-trace.json#event=c-failure"],
          rationale: "Route defect."
        },
        {
          findingId: "judge-artifact",
          defectClass: "artifact_integrity",
          severity: "medium",
          verdict: "defect",
          evidenceRefs: ["candidate:workflow-trace.json#event=c-gate"],
          rationale: "Potential artifact defect."
        },
        {
          findingId: "judge-process",
          defectClass: "process_failure",
          severity: "low",
          verdict: "not_a_defect",
          evidenceRefs: ["candidate:workflow-trace.json#event=c-route"],
          rationale: "No process defect."
        }
      ]
    };
    const labels: HumanTrajectoryLabels = {
      blinded: true,
      raters: [
        { raterId: "rater-a", expertise: "workflow" },
        { raterId: "rater-b", expertise: "workflow" }
      ],
      labels: [
        {
          raterId: "rater-a",
          findingId: "judge-route",
          defectClass: "route_integrity",
          isDefect: true
        },
        {
          raterId: "rater-b",
          findingId: "judge-route",
          defectClass: "route_integrity",
          isDefect: true
        },
        {
          raterId: "rater-a",
          findingId: "judge-artifact",
          defectClass: "artifact_integrity",
          isDefect: false,
          evidenceRefs: ["candidate:workflow-trace.json#event=c-gate"]
        },
        {
          raterId: "rater-b",
          findingId: "judge-artifact",
          defectClass: "artifact_integrity",
          isDefect: false,
          evidenceRefs: ["candidate:workflow-trace.json#event=c-gate"]
        },
        {
          raterId: "rater-a",
          findingId: "judge-process",
          defectClass: "process_failure",
          isDefect: true
        },
        {
          raterId: "rater-b",
          findingId: "judge-process",
          defectClass: "process_failure",
          isDefect: true
        }
      ]
    };

    const review = buildTrajectoryReview({
      traceDiff,
      traceDiffRef: "trace-diff.json",
      traceDiffHash: sha256Text(stableJson(traceDiff)),
      judgeFindings: judge,
      humanLabels: labels
    });

    expect(review.validation.status).toBe("VALIDATED_DIAGNOSTIC");
    if (review.validation.status !== "VALIDATED_DIAGNOSTIC") {
      throw new Error("expected validated diagnostic labels");
    }
    expect(review.validation.metricsByClass).toContainEqual(
      expect.objectContaining({
        defectClass: "route_integrity",
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        precision: 1,
        recall: 1
      })
    );
    expect(review.validation.metricsByClass).toContainEqual(
      expect.objectContaining({
        defectClass: "artifact_integrity",
        truePositive: 0,
        falsePositive: 1,
        falseNegative: 0,
        precision: 0,
        recall: 0
      })
    );
    expect(review.validation.metricsByClass).toContainEqual(
      expect.objectContaining({
        defectClass: "process_failure",
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 1,
        precision: 0,
        recall: 0
      })
    );
    expect(review.validation.interRaterAgreement).toBe(1);
    expect(review.validation.disagreements).toEqual([]);
  });

  test("records tied human labels as disagreement instead of positive consensus", () => {
    const traceDiff = baselineCandidateTraceDiff();
    const judge: JudgeTrajectoryFindings = {
      model: "judge-model",
      promptHash: HASH_A,
      rubricHash: HASH_B,
      calibrationSetIdentity: "calibration:v1",
      findings: [
        {
          findingId: "judge-route",
          defectClass: "route_integrity",
          severity: "high",
          verdict: "defect",
          evidenceRefs: ["candidate:workflow-trace.json#event=c-failure"],
          rationale: "Route defect."
        }
      ]
    };
    const labels: HumanTrajectoryLabels = {
      blinded: true,
      raters: [
        { raterId: "rater-a", expertise: "workflow" },
        { raterId: "rater-b", expertise: "workflow" }
      ],
      labels: [
        {
          raterId: "rater-a",
          findingId: "judge-route",
          defectClass: "route_integrity",
          isDefect: true
        },
        {
          raterId: "rater-b",
          findingId: "judge-route",
          defectClass: "route_integrity",
          isDefect: false
        }
      ]
    };

    const review = buildTrajectoryReview({
      traceDiff,
      traceDiffRef: "trace-diff.json",
      traceDiffHash: sha256Text(stableJson(traceDiff)),
      judgeFindings: judge,
      humanLabels: labels
    });
    expect(review.validation.status).toBe("VALIDATED_DIAGNOSTIC");
    if (review.validation.status !== "VALIDATED_DIAGNOSTIC") {
      throw new Error("expected validated diagnostic labels");
    }
    expect(review.validation.disagreements).toEqual([
      {
        findingId: "judge-route",
        defectClass: "route_integrity",
        positiveLabels: 1,
        negativeLabels: 1,
        disposition: "NO_CONSENSUS"
      }
    ]);
    expect(review.validation.metricsByClass).toContainEqual(
      expect.objectContaining({
        defectClass: "route_integrity",
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 0
      })
    );
  });

  test("rejects human calibration labels without judge findings or a complete label matrix", () => {
    const traceDiff = baselineCandidateTraceDiff();
    const labels: HumanTrajectoryLabels = {
      blinded: true,
      raters: [
        { raterId: "rater-a", expertise: "workflow" },
        { raterId: "rater-b", expertise: "workflow" }
      ],
      labels: [
        {
          raterId: "rater-a",
          findingId: "judge-route",
          defectClass: "route_integrity",
          isDefect: true
        }
      ]
    };

    expect(() =>
      buildTrajectoryReview({
        traceDiff,
        traceDiffRef: "trace-diff.json",
        traceDiffHash: sha256Text(stableJson(traceDiff)),
        humanLabels: labels
      })
    ).toThrow(/judge findings/i);

    expect(() =>
      buildTrajectoryReview({
        traceDiff,
        traceDiffRef: "trace-diff.json",
        traceDiffHash: sha256Text(stableJson(traceDiff)),
        judgeFindings: {
          model: "judge-model",
          promptHash: HASH_A,
          rubricHash: HASH_B,
          calibrationSetIdentity: "calibration:v1",
          findings: [
            {
              findingId: "judge-route",
              defectClass: "route_integrity",
              severity: "high",
              verdict: "defect",
              evidenceRefs: ["candidate:workflow-trace.json#event=c-failure"],
              rationale: "Route defect."
            }
          ]
        },
        humanLabels: labels
      })
    ).toThrow(/complete blinded label matrix/i);
  });

  test("covers mutant restore recovery and emits no raw payload, actor, or absolute path", () => {
    const traceDiff = mutantRestoreTraceDiff();
    const review = buildTrajectoryReview({
      traceDiff,
      traceDiffRef: "trace-diff.json",
      traceDiffHash: sha256Text(stableJson(traceDiff))
    });
    const markdown = renderTrajectoryReviewMarkdown(review);
    const serialized = `${stableJson(review)}\n${markdown}`;

    expect(review.deterministicFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "mutant",
          recovery: expect.objectContaining({
            outcome: "restored",
            attempts: 1
          })
        })
      ])
    );
    const mutantFinding = review.deterministicFindings.find(
      (finding) => finding.lane === "mutant"
    );
    expect(mutantFinding).toBeDefined();
    if (mutantFinding!.recovery.recoveryLatencyMs !== undefined) {
      expect(mutantFinding!.recovery.recoveryLatencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(serialized).not.toContain("frontend-owner");
    expect(serialized).not.toContain("runner");
    expect(serialized).not.toContain(["", "Users", ""].join("/"));
    expect(serialized).not.toContain("secret raw text");
  });

  test("validates schema and CLI output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "awb-trajectory-review-"));
    tempRoots.push(root);
    const out = path.join(root, "out");
    await mkdir(out);
    const traceDiff = baselineCandidateTraceDiff();
    const traceDiffPath = path.join(root, "trace-diff.json");
    await writeFile(traceDiffPath, `${JSON.stringify(traceDiff, null, 2)}\n`);

    const execution = await execa(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "report",
        "trajectory-review",
        "--trace-diff",
        traceDiffPath,
        "--out",
        out
      ],
      { cwd: process.cwd(), reject: false }
    );

    expect(execution.exitCode).toBe(2);
    expect(execution.stdout).toContain("trajectory review DIAGNOSTIC_ONLY");
    const report = JSON.parse(
      await readFile(path.join(out, "trajectory-review.json"), "utf8")
    );
    const schema = JSON.parse(
      await readFile(
        path.join(process.cwd(), "schemas/trajectory-review.schema.json"),
        "utf8"
      )
    );
    const ajv = createAjv2020();
    const validate = ajv.compile(schema);
    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
    expect(
      await readFile(path.join(out, "trajectory-review.md"), "utf8")
    ).toContain("Trajectory Review");
  });
});

function baselineCandidateTraceDiff() {
  return buildTraceDiff({
    mode: "baseline_candidate",
    targetId: "target-a",
    suite: "smoke",
    comparability: { status: "COMPARABLE", reasons: [] },
    baseline: trace("baseline", [
      event("b-start", "case_start", "runner", { note: "secret raw text" }),
      event("b-route", "handoff", "runner", { to: "backend-owner" }),
      event("b-gate", "gate_decision", "runner", { status: "PASS" })
    ]),
    candidate: trace("candidate", [
      event("c-start", "case_start", "runner", { note: "secret raw text" }),
      event("c-route", "handoff", "runner", { to: "frontend-owner" }),
      event("c-failure", "hard_failure", "observer", {
        code: "TARGET_ROUTE_FORBIDDEN"
      }),
      event("c-gate", "gate_decision", "runner", { status: "BLOCK" })
    ])
  });
}

function mutantRestoreTraceDiff() {
  return buildTraceDiff({
    mode: "baseline_mutant_restore",
    targetId: "target-a",
    suite: "smoke",
    comparability: { status: "COMPARABLE", reasons: [] },
    baseline: trace("baseline", [
      event("b-route", "handoff", "runner", { to: "backend-owner" }),
      event("b-gate", "gate_decision", "runner", { status: "PASS" })
    ]),
    mutant: trace("mutant", [
      event("m-route", "handoff", "runner", { to: "frontend-owner" }),
      event("m-failure", "hard_failure", "observer", {
        code: "TARGET_ROUTE_FORBIDDEN"
      })
    ]),
    restore: trace("restore", [
      event("r-route", "handoff", "runner", { to: "backend-owner" }),
      event("r-gate", "gate_decision", "runner", { status: "PASS" })
    ])
  });
}

function trace(label: string, events: RunEvent[]) {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: sha256Text(label),
    cases: [
      {
        caseId: "case-route",
        templateId: "owner-route",
        events
      }
    ]
  };
}

function event(
  eventId: string,
  type: RunEvent["type"],
  actor: string,
  payload: Record<string, unknown>,
  timestamp?: string
): RunEvent {
  return {
    eventId,
    timestamp: timestamp ?? `2026-07-26T00:00:0${eventId.length % 10}.000Z`,
    type,
    actor,
    payload
  };
}
