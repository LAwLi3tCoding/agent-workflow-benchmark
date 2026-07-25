import { describe, expect, test } from "vitest";
import { renderReadOnlyHtmlViewer } from "../src/report/htmlViewer.js";

describe("Stage 9 read-only HTML viewer", () => {
  test("escapes and redacts private data while preserving gate evidence immutably", () => {
    const localPath = ["/", "private", "/", "target", "/", "secret.txt"].join("");
    const secret = ["sk", "stage9", "secret"].join("-");
    const html = renderReadOnlyHtmlViewer({
      title: "Stage 9 <Decision>",
      decisionReport: {
        artifactType: "decision_report",
        gateDecision: "BLOCK",
        evidenceRefs: ["candidate:workflow-trace.json#event=event-route"],
        executiveSummary: {
          topRisks: [
            {
              code: "SECRET_LEAK",
              why: `leaked ${secret} at ${localPath}`
            }
          ]
        }
      },
      comparison: {
        classification: "HARD_FAILURE",
        gatePolicy: { policyVersion: "1.0.0" }
      },
      traceDiff: {
        artifactType: "trace_diff",
        caseDiffs: []
      }
    });

    expect(html).toContain("&lt;Decision&gt;");
    expect(html).toContain("Gate Decision");
    expect(html).toContain("BLOCK");
    expect(html).toContain("candidate:workflow-trace.json#event=event-route");
    expect(html).not.toContain(localPath);
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(/<form\b|<input\b|contenteditable|fetch\(|localStorage|sessionStorage|XMLHttpRequest|navigator\.sendBeacon/iu);
    expect(html).toContain("data-awb-readonly=\"true\"");
    expect(html).toContain("data-gate-decision=\"BLOCK\"");
  });
});
