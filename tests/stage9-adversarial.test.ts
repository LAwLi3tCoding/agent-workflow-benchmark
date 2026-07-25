import { describe, expect, test } from "vitest";
import { renderReadOnlyHtmlViewer } from "../src/report/htmlViewer.js";
import { buildTraceDiff } from "../src/report/traceDiff.js";
import { sha256Text } from "../src/utils/hash.js";
import type { RunEvent } from "../src/core/types.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("Stage 9 adversarial report rendering", () => {
  test("escapes executable HTML and redacts secrets in the read-only viewer", () => {
    const secret = ["sk", "stage9", "viewer", "secret"].join("-");
    const localPath = ["/", "private", "/", "target", "/", "secret.txt"].join("");
    const javascriptUrl = ["java", "script", ":alert(1)"].join("");
    const html = renderReadOnlyHtmlViewer({
      title: `Stage 9 </style><script>alert("${secret}")</script>`,
      decisionReport: {
        artifactType: "decision_report",
        gateDecision: "BLOCK",
        targetId: `target <img src=x onerror=alert("${secret}")>`,
        suite: "smoke",
        evidenceRefs: [
          "candidate:workflow-trace.json#event=event-route",
          javascriptUrl
        ],
        executiveSummary: {
          topRisks: [
            {
              severity: "P0",
              code: `</style><img src=x onerror=alert("${secret}")>`,
              owner: `<script>alert("${secret}")</script>`,
              affectedCaseIds: ["case-route"],
              why: `${javascriptUrl} leaked ${secret} at ${localPath}`
            }
          ]
        },
        caseImpacts: [
          {
            caseId: `case-route <script>alert("${secret}")</script>`,
            classification: "REGRESSED",
            scoreDelta: -20,
            evidenceRefs: ["candidate:workflow-trace.json#event=event-route"],
            retestCondition: `do not execute </style><img src=x onerror=alert("${secret}")>`
          }
        ]
      },
      traceDiff: {
        artifactType: "trace_diff",
        caseDiffs: [
          {
            caseId: "case-route",
            eventDeltas: [
              {
                kind: "added",
                type: "hard_failure",
                candidateRef: "candidate:workflow-trace.json#event=event-route",
                provenance: {
                  candidateActorHash: HASH_A
                }
              }
            ]
          }
        ]
      }
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;/style&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("candidate:workflow-trace.json#event=event-route");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</style><script");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).not.toContain(secret);
    expect(html).not.toContain(localPath);
    expect(html).not.toContain(javascriptUrl);
    expect(html).not.toMatch(
      /<(?:img|script|style)\b[^>]*\bonerror\s*=|javascript:|fetch\(|localStorage|sessionStorage|XMLHttpRequest|navigator\.sendBeacon/iu
    );
    expect(html).toContain("data-awb-readonly=\"true\"");
    expect(html).toContain("default-src 'none'");
  });
});

describe("Stage 9 adversarial trace diff bounds", () => {
  test("rejects oversized event payloads without echoing payload content", () => {
    const oversizedSecret = "oversized-stage9-secret-payload";

    expect(() =>
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "COMPARABLE", reasons: [] },
        maxPayloadBytes: 32,
        baseline: trace("baseline", [
          event("b-start", { marker: "small" })
        ]),
        candidate: trace("candidate", [
          event("c-oversized", {
            marker: oversizedSecret,
            body: "x".repeat(128)
          })
        ])
      })
    ).toThrowError(
      /trace diff candidate\/case-route\/c-oversized exceeds maxPayloadBytes: \d+ > 32/u
    );

    try {
      buildTraceDiff({
        mode: "baseline_candidate",
        targetId: "target-a",
        suite: "smoke",
        comparability: { status: "COMPARABLE", reasons: [] },
        maxPayloadBytes: 32,
        baseline: trace("baseline", [
          event("b-start", { marker: "small" })
        ]),
        candidate: trace("candidate", [
          event("c-oversized", {
            marker: oversizedSecret,
            body: "x".repeat(128)
          })
        ])
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(oversizedSecret);
      expect((error as Error).message).not.toContain("x".repeat(128));
    }
  });
});

function trace(label: string, events: RunEvent[]): any {
  return {
    ref: `${label}:workflow-trace.json`,
    traceHash: label === "baseline" ? HASH_A : HASH_B,
    cases: [{ caseId: "case-route", templateId: "owner-route", events }]
  };
}

function event(
  eventId: string,
  payload: Record<string, unknown>
): RunEvent {
  return {
    eventId,
    timestamp: "2026-07-26T00:00:00.000Z",
    type: "case_start",
    actor: "observer",
    payload
  };
}
