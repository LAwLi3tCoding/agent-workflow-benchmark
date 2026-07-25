import { describe, expect, test } from "vitest";
import { buildTraceDiff } from "../src/report/traceDiff.js";
import type { RunEvent } from "../src/core/types.js";
import { sha256Text } from "../src/utils/hash.js";

describe("Stage 9 trace diff", () => {
  test("diffs baseline and candidate events with provenance references", () => {
    const diff = buildTraceDiff({
      mode: "baseline_candidate",
      targetId: "target-a",
      suite: "smoke",
      comparability: { status: "COMPARABLE", reasons: [] },
      baseline: trace("baseline", [
        event("b-start", "case_start", "runner", { caseId: "case-route" }),
        event("b-route", "handoff", "runner", { to: "backend-owner" }),
        event("b-gate", "gate_decision", "runner", { status: "PASS" })
      ]),
      candidate: trace("candidate", [
        event("c-start", "case_start", "runner", { caseId: "case-route" }),
        event("c-route", "handoff", "runner", { to: "frontend-owner" }),
        event("c-failure", "hard_failure", "observer", {
          code: "TARGET_ROUTE_FORBIDDEN"
        }),
        event("c-gate", "gate_decision", "runner", { status: "PASS" })
      ])
    });

    expect(diff).toMatchObject({
      schemaVersion: "0.1.0",
      artifactType: "trace_diff",
      mode: "baseline_candidate",
      summary: {
        added: 1,
        removed: 0,
        changed: 1,
        unchanged: 2
      }
    });
    expect(diff.caseDiffs).toContainEqual(
      expect.objectContaining({
        caseId: "case-route",
        eventDeltas: expect.arrayContaining([
          expect.objectContaining({
            kind: "changed",
            type: "handoff",
            baselineRef: "baseline:workflow-trace.json#event=b-route",
            candidateRef: "candidate:workflow-trace.json#event=c-route"
          }),
          expect.objectContaining({
            kind: "added",
            type: "hard_failure",
            candidateRef: "candidate:workflow-trace.json#event=c-failure",
            provenance: expect.objectContaining({
              candidateActorHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
            })
          })
        ])
      })
    );
  });

  test("keeps cross-type event reordering visible", () => {
    const diff = buildTraceDiff({
      mode: "baseline_candidate",
      targetId: "target-a",
      suite: "smoke",
      comparability: { status: "COMPARABLE", reasons: [] },
      baseline: trace("baseline", [
        event("b-start", "case_start", "runner", { caseId: "case-route" }),
        event("b-route", "handoff", "runner", { to: "backend-owner" })
      ]),
      candidate: trace("candidate", [
        event("c-route", "handoff", "runner", { to: "backend-owner" }),
        event("c-start", "case_start", "runner", { caseId: "case-route" })
      ])
    });

    expect(diff.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 2,
      unchanged: 0
    });
    expect(diff.caseDiffs[0]!.eventDeltas).toContainEqual(
      expect.objectContaining({
        kind: "changed",
        type: "case_start",
        baselinePosition: 0,
        candidatePosition: 1
      })
    );
  });

  test("diffs baseline, mutant, and restore traces without hiding restore regressions", () => {
    const diff = buildTraceDiff({
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
        event("r-failure", "hard_failure", "observer", {
          code: "TARGET_JOIN_MISSING"
        })
      ])
    });

    expect(diff.mode).toBe("baseline_mutant_restore");
    expect(diff.restoreStatus).toBe("REGRESSED");
    expect(diff.caseDiffs[0].eventDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mutant_added",
          type: "hard_failure",
          mutantRef: "mutant:workflow-trace.json#event=m-failure"
        }),
        expect.objectContaining({
          kind: "restore_added",
          type: "hard_failure",
          restoreRef: "restore:workflow-trace.json#event=r-failure"
        })
      ])
    );
  });

  test("keeps a no-op mutant visible while marking an identical restore as restored", () => {
    const baselineEvents = [
      event("b-route", "handoff", "runner", { to: "backend-owner" }),
      event("b-gate", "gate_decision", "runner", { status: "PASS" })
    ];
    const diff = buildTraceDiff({
      mode: "baseline_mutant_restore",
      targetId: "target-a",
      suite: "smoke",
      comparability: { status: "COMPARABLE", reasons: [] },
      baseline: trace("baseline", baselineEvents),
      mutant: trace("mutant", [
        event("m-route", "handoff", "runner", { to: "backend-owner" }),
        event("m-gate", "gate_decision", "runner", { status: "PASS" })
      ]),
      restore: trace("restore", [
        event("r-route", "handoff", "runner", { to: "backend-owner" }),
        event("r-gate", "gate_decision", "runner", { status: "PASS" })
      ])
    });

    expect(diff.restoreStatus).toBe("RESTORED");
    expect(diff.caseDiffs[0].eventDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mutant_unchanged" }),
        expect.objectContaining({ kind: "restore_unchanged" })
      ])
    );
  });

  test("refuses to label a trace diff verified_live without qualification bindings", () => {
    expect(() =>
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "COMPARABLE", reasons: [] },
        evidenceLevel: "verified_live",
        baseline: trace("baseline", [
          event("b-start", "case_start", "observer", {})
        ]),
        candidate: trace("candidate", [
          event("c-start", "case_start", "observer", {})
        ])
      })
    ).toThrow(/qualification bindings/iu);
  });

  test("rejects event ids that cannot be emitted as public portable refs", () => {
    const privateEventId = "../private-event-id";

    expect(() =>
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "COMPARABLE", reasons: [] },
        baseline: trace("baseline", [
          event(privateEventId, "case_start", "observer", {})
        ]),
        candidate: trace("candidate", [
          event("candidate-start", "case_start", "observer", {})
        ])
      })
    ).toThrow(/non-portable eventId/iu);

    try {
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "COMPARABLE", reasons: [] },
        baseline: trace("baseline", [
          event(privateEventId, "case_start", "observer", {})
        ]),
        candidate: trace("candidate", [
          event("candidate-start", "case_start", "observer", {})
        ])
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(privateEventId);
    }
  });

  test("requires trace comparability status and reasons to agree", () => {
    const baseline = trace("baseline", [
      event("baseline-start", "case_start", "observer", {})
    ]);
    const candidate = trace("candidate", [
      event("candidate-start", "case_start", "observer", {})
    ]);

    expect(() =>
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "INCOMPARABLE", reasons: [] },
        baseline,
        candidate
      })
    ).toThrow(/INCOMPARABLE trace diff requires/iu);

    expect(() =>
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: {
          status: "COMPARABLE",
          reasons: ["TRACE_POLICY_MISMATCH"]
        },
        baseline,
        candidate
      })
    ).toThrow(/COMPARABLE trace diff cannot/iu);
  });
});

function trace(label: string, events: RunEvent[]): any {
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
  payload: Record<string, unknown>
): RunEvent {
  return {
    eventId,
    timestamp: `2026-07-26T00:00:0${eventId.length % 10}.000Z`,
    type,
    actor,
    payload
  };
}
