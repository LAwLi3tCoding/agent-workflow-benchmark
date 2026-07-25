import { PRODUCT_NAME } from "../core/product.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
const MAX_INPUT_CHARS = 1_000_000;
const MAX_RISKS = 50;
const MAX_CASES = 200;
const MAX_EVIDENCE_REFS = 100;
const MAX_TRACE_CASES = 50;
const MAX_EVENT_DELTAS = 200;
const MAX_CELL_CHARS = 500;
export function renderReadOnlyHtmlViewer(input) {
    const serializedInput = stableJson(input);
    const oversized = serializedInput.length > MAX_INPUT_CHARS;
    const manifest = {
        artifactType: "html_viewer_manifest",
        product: PRODUCT_NAME,
        inputHash: sha256Text(serializedInput),
        inputBytes: serializedInput.length,
        inputStatus: oversized ? "oversized_redacted_summary_only" : "rendered",
        renderedAt: new Date(0).toISOString(),
        security: {
            staticHtml: true,
            readOnly: true,
            scripts: "none",
            network: "none",
            storage: "none",
            redaction: "before_html_escape"
        }
    };
    const decision = oversized ? {} : readObject(input.decisionReport);
    const comparison = oversized ? {} : readObject(input.comparison);
    const traceDiff = oversized ? {} : readObject(input.traceDiff);
    const trends = oversized ? {} : readObject(input.trends);
    const gateDecision = textField(decision, "gateDecision") ?? textField(decision, "decision") ?? "UNKNOWN";
    const evidenceRefs = collectEvidenceRefs(decision, comparison).slice(0, MAX_EVIDENCE_REFS);
    return [
        "<!doctype html>",
        `<html lang="en" data-awb-readonly="true" data-gate-decision="${attr(gateDecision)}">`,
        "<head>",
        `<meta charset="utf-8">`,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'">`,
        `<meta name="referrer" content="no-referrer">`,
        `<meta name="awb-readonly" content="true">`,
        `<meta name="awb-input-hash" content="${attr(manifest.inputHash)}">`,
        `<title>${safe(input.title)}</title>`,
        "<style>",
        "body{margin:0;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172026;background:#f6f7f9}",
        "main{max-width:1120px;margin:0 auto;padding:32px 24px}",
        "h1{font-size:28px;margin:0 0 20px}h2{font-size:18px;margin:28px 0 12px}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}",
        ".metric,.panel{background:#fff;border:1px solid #d9dee7;border-radius:8px;padding:14px}",
        ".label{font-size:12px;color:#5d6878;text-transform:uppercase}.value{font-size:20px;font-weight:650;margin-top:4px}",
        "table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9dee7;border-radius:8px;overflow:hidden}",
        "th,td{text-align:left;border-bottom:1px solid #e7ebf0;padding:9px 10px;vertical-align:top;word-break:break-word}",
        "th{font-size:12px;color:#4b5565;background:#eef1f5}tr:last-child td{border-bottom:0}",
        ".mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.muted{color:#667085}",
        "</style>",
        "</head>",
        "<body>",
        "<main>",
        `<h1>${safe(input.title)}</h1>`,
        oversized ? `<section class="panel" data-awb-input-status="oversized">Input exceeded the bounded viewer limit; only immutable manifest metadata is rendered.</section>` : "",
        `<section class="grid" aria-label="immutable gate summary">`,
        metric("Gate Decision", gateDecision),
        metric("Classification", textField(decision, "classification") ?? textField(comparison, "classification") ?? "UNKNOWN"),
        metric("Target", textField(decision, "targetId") ?? textField(readObject(comparison.candidate), "targetId") ?? "UNKNOWN"),
        metric("Suite", textField(decision, "suite") ?? textField(readObject(comparison.candidate), "suite") ?? "UNKNOWN"),
        "</section>",
        section("Top Risks", riskRows(decision)),
        section("Case Impact", caseRows(decision, comparison)),
        section("Evidence", evidenceRows(evidenceRefs)),
        section("Trace Diff", traceRows(traceDiff)),
        section("Trends", trendRows(trends)),
        `<section class="panel" data-awb-manifest="true"><h2>Viewer Manifest</h2><pre class="mono">${safe(stableJson(manifest))}</pre></section>`,
        "</main>",
        "</body>",
        "</html>"
    ].join("\n");
}
export function buildHtmlViewerArtifacts(input, options = {}) {
    assertAlreadyRedactedArtifacts(input);
    assertAlreadyRedactedManifestInputs(options.inputs);
    const html = renderReadOnlyHtmlViewer(input);
    const inputs = inputManifestEntries(input, options.inputs);
    if (inputs.length === 0) {
        throw new Error("HTML viewer requires at least one already-redacted public artifact.");
    }
    const viewerRef = options.viewerRef ?? "viewer.html";
    if (!isPortableArtifactRef(viewerRef)) {
        throw new Error("HTML viewerRef must be a portable artifact reference.");
    }
    const manifestWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "html_viewer_manifest",
        product: PRODUCT_NAME,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        publicSafe: true,
        readOnly: true,
        inputs,
        display: {
            title: sanitizeViewerText(input.title),
            sections: visibleSections(input),
            redactionMode: "public_redacted"
        },
        restrictions: {
            mayChangeGateResult: false,
            mayReadUnredactedTrace: false,
            mayLoadRemoteAssets: false,
            mayExecuteCommands: false,
            mayWriteArtifacts: false
        }
    };
    if (!Number.isFinite(Date.parse(manifestWithoutIntegrity.generatedAt))) {
        throw new Error("HTML viewer generatedAt must be an ISO timestamp.");
    }
    return {
        html,
        manifest: {
            ...manifestWithoutIntegrity,
            integrity: {
                status: "VERIFIED_AT_WRITE",
                contentHash: sha256Text(stableJson(manifestWithoutIntegrity)),
                viewerRef,
                viewerHash: sha256Text(html),
                artifacts: inputs.map(({ ref, sha256 }) => ({ ref, sha256 }))
            }
        }
    };
}
function metric(label, value) {
    return `<div class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div></div>`;
}
function section(title, rows) {
    return `<section><h2>${safe(title)}</h2>${rows}</section>`;
}
function riskRows(decision) {
    const summary = readObject(decision.executiveSummary);
    const risks = readArray(summary.topRisks).slice(0, MAX_RISKS).map(readObject);
    if (risks.length === 0) {
        return `<div class="panel muted">No top risks recorded.</div>`;
    }
    return table(["Severity", "Code", "Owner", "Affected Cases", "Why"], risks.map((risk) => [
        textField(risk, "severity") ?? "",
        textField(risk, "code") ?? "",
        textField(risk, "owner") ?? "",
        readArray(risk.affectedCaseIds).map(toText).join(", "),
        textField(risk, "why") ?? ""
    ]));
}
function caseRows(decision, comparison) {
    const decisionCases = readArray(decision.caseImpacts).map(readObject);
    const comparisonCases = readArray(comparison.caseDeltas).map(readObject);
    const rows = (decisionCases.length > 0 ? decisionCases : comparisonCases).slice(0, MAX_CASES);
    if (rows.length === 0) {
        return `<div class="panel muted">No case impacts recorded.</div>`;
    }
    return table(["Case", "Classification", "Score Delta", "Evidence", "Retest"], rows.map((item) => [
        textField(item, "caseId") ?? "",
        textField(item, "classification") ?? "",
        textField(item, "scoreDelta") ?? "",
        collectEvidenceRefs(item).slice(0, 5).join(", "),
        textField(item, "retestCondition") ?? ""
    ]));
}
function evidenceRows(refs) {
    if (refs.length === 0) {
        return `<div class="panel muted">No evidence refs recorded.</div>`;
    }
    return table(["Evidence Ref"], refs.map((ref) => [ref]));
}
function traceRows(traceDiff) {
    const rows = [];
    for (const caseDiff of readArray(traceDiff.caseDiffs).slice(0, MAX_TRACE_CASES).map(readObject)) {
        for (const delta of readArray(caseDiff.eventDeltas).slice(0, MAX_EVENT_DELTAS).map(readObject)) {
            rows.push([
                textField(caseDiff, "caseId") ?? "",
                textField(delta, "kind") ?? "",
                textField(delta, "type") ?? "",
                [
                    textField(delta, "baselineRef"),
                    textField(delta, "candidateRef"),
                    textField(delta, "mutantRef"),
                    textField(delta, "restoreRef")
                ].filter(Boolean).join(", "),
                [
                    textField(readObject(delta.provenance), "baselineActorHash"),
                    textField(readObject(delta.provenance), "candidateActorHash"),
                    textField(readObject(delta.provenance), "mutantActorHash"),
                    textField(readObject(delta.provenance), "restoreActorHash")
                ].filter(Boolean).join(", ")
            ]);
        }
    }
    if (rows.length === 0) {
        return `<div class="panel muted">No trace deltas recorded.</div>`;
    }
    return table(["Case", "Kind", "Type", "Refs", "Actor Hashes"], rows.slice(0, MAX_EVENT_DELTAS));
}
function trendRows(trends) {
    const segments = readArray(trends.segments).slice(0, MAX_CASES).map(readObject);
    if (segments.length === 0) {
        return `<div class="panel muted">No trend segments recorded.</div>`;
    }
    return table(["Segment", "Status", "Reasons", "Points"], segments.map((segment) => [
        textField(segment, "segmentId") ?? "",
        textField(segment, "status") ?? "",
        readArray(segment.reasonCodes).map(toText).join(", "),
        readArray(segment.pointIds).map(toText).join(", ")
    ]));
}
function table(headers, rows) {
    return [
        "<table>",
        `<thead><tr>${headers.map((header) => `<th>${safe(header)}</th>`).join("")}</tr></thead>`,
        `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${safeCell(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
        "</table>"
    ].join("");
}
function collectEvidenceRefs(...values) {
    const refs = new Set();
    for (const value of values) {
        collectEvidenceRefsInto(value, refs);
    }
    return [...refs];
}
function inputManifestEntries(input, explicitInputs) {
    const displayedInputs = viewerInputValues(input);
    if (explicitInputs && explicitInputs.length > 0) {
        if (explicitInputs.length !== displayedInputs.length ||
            new Set(explicitInputs.map((item) => item.artifactType)).size !==
                explicitInputs.length) {
            throw new Error("HTML viewer manifest inputs must match the displayed artifacts.");
        }
        return explicitInputs.map((item) => {
            const displayed = displayedInputs.find((candidate) => candidate.artifactType === item.artifactType);
            if (!displayed ||
                item.value === undefined ||
                stableJson(item.value) !== stableJson(displayed.value)) {
                throw new Error("HTML viewer manifest inputs must match the displayed artifacts.");
            }
            if (!isPortableArtifactRef(item.ref)) {
                throw new Error(`HTML viewer input ref is not portable: ${item.ref}`);
            }
            const computedHash = sha256Text(stableJson(item.value));
            if (item.sha256 && computedHash && item.sha256 !== computedHash) {
                throw new Error(`HTML viewer input hash mismatch for ${item.ref}.`);
            }
            const sha256 = item.sha256 ?? computedHash;
            if (!sha256 || !isSha256(sha256)) {
                throw new Error(`HTML viewer input hash is missing or invalid for ${item.ref}.`);
            }
            return {
                artifactType: item.artifactType,
                ref: item.ref,
                sha256,
                schemaVersion: item.schemaVersion ?? "0.1.0"
            };
        });
    }
    return displayedInputs.map(({ artifactType, ref, value }) => ({
        artifactType,
        ref,
        sha256: sha256Text(stableJson(value)),
        schemaVersion: "0.1.0"
    }));
}
function viewerInputValues(input) {
    return [
        ["decision_report", "decision-report.json", input.decisionReport],
        ["comparison_result", "comparison-result.json", input.comparison],
        ["trace_diff", "trace-diff.json", input.traceDiff],
        ["trend_report", "trend-report.json", input.trends]
    ]
        .filter((entry) => entry[2] !== undefined)
        .map(([artifactType, ref, value]) => ({ artifactType, ref, value }));
}
function assertAlreadyRedactedArtifacts(input) {
    for (const value of [
        input.decisionReport,
        input.comparison,
        input.traceDiff,
        input.trends
    ]) {
        if (value === undefined) {
            continue;
        }
        const serialized = stableJson(value);
        if (redactSensitiveText(serialized) !== serialized) {
            throw new Error("HTML viewer artifacts must be built from already-redacted public artifacts.");
        }
    }
}
function assertAlreadyRedactedManifestInputs(inputs) {
    for (const item of inputs ?? []) {
        if (item.value === undefined) {
            continue;
        }
        const serialized = stableJson(item.value);
        if (redactSensitiveText(serialized) !== serialized) {
            throw new Error("HTML viewer artifacts must be built from already-redacted public artifacts.");
        }
    }
}
function visibleSections(input) {
    const sections = [
        "summary",
        "evidence"
    ];
    if (input.decisionReport !== undefined || input.comparison !== undefined) {
        sections.push("decision");
    }
    if (input.traceDiff !== undefined) {
        sections.push("trace_diff");
    }
    if (input.trends !== undefined) {
        sections.push("trend");
    }
    return sections;
}
function isPortableArtifactRef(ref) {
    return (ref.length > 0 &&
        ref.length <= 256 &&
        /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*@)(?!.*\\)[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref));
}
function isSha256(value) {
    return /^sha256:[a-f0-9]{64}$/u.test(value);
}
function collectEvidenceRefsInto(value, refs) {
    if (typeof value === "string") {
        if (isEvidenceRef(value)) {
            refs.add(value);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectEvidenceRefsInto(item, refs);
        }
        return;
    }
    if (!value || typeof value !== "object") {
        return;
    }
    for (const [key, item] of Object.entries(value)) {
        if (key === "payload" || key.endsWith("Path") || key === "path") {
            continue;
        }
        collectEvidenceRefsInto(item, refs);
    }
}
function isEvidenceRef(value) {
    return /^(?:baseline|candidate|comparison|gate|policy|mutant|restore):[A-Za-z0-9._/#:=+-]+$/u.test(value);
}
function safeCell(value) {
    return safe(toText(value).slice(0, MAX_CELL_CHARS));
}
function safe(value) {
    return escapeHtml(sanitizeViewerText(toText(value)));
}
function attr(value) {
    return safe(value).replace(/`/gu, "&#96;");
}
function escapeHtml(value) {
    return value
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;")
        .replace(/'/gu, "&#39;");
}
function sanitizeViewerText(value) {
    return redactSensitiveText(value).replace(/\bjavascript\s*:/giu, "[blocked-scheme]:");
}
function toText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (value === null || value === undefined) {
        return "";
    }
    return stableJson(value);
}
function textField(source, key) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}
function readObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readArray(value) {
    return Array.isArray(value) ? value : [];
}
