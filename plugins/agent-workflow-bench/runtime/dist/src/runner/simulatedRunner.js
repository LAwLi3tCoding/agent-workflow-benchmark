export function runCase(testCase, contract, mutation) {
    const runId = `run-${testCase.id}-${mutation?.id ?? "baseline"}`;
    const events = [];
    let seq = 0;
    const push = (type, actor, payload) => {
        seq += 1;
        events.push({
            eventId: `event-${String(seq).padStart(3, "0")}`,
            timestamp: new Date(seq * 1000).toISOString(),
            type,
            actor,
            payload
        });
    };
    const primaryRole = testCase.bindings.primaryRole ?? contract.roles[0]?.id ?? "agent";
    push("case_start", "benchmark", { caseId: testCase.id, templateId: testCase.templateId });
    push("contract_observed", "benchmark", { contractHash: contract.contractHash });
    push("handoff", primaryRole, { to: testCase.bindings.owner, status: "accepted" });
    push("artifact_write", testCase.bindings.owner ?? primaryRole, { path: testCase.bindings.artifactPath, bytes: 128 });
    push("state_read", testCase.bindings.owner ?? primaryRole, { path: contract.states[0]?.path ?? "process/state.json" });
    push("gate_decision", testCase.bindings.owner ?? primaryRole, { status: "PASS" });
    if (testCase.templateId === "side-effect-deny") {
        push("side_effect_attempt", "benchmark", {
            command: "fake-tool-preflight",
            policyDecision: "allow",
            allowed: true,
            classifiedAs: "sandbox_preflight"
        });
    }
    if (mutation) {
        appendMutationEvent(mutation, push);
    }
    push("token_usage", "runner", { input: 900, output: 180, total: 1080, wasted: mutation?.type === "token-ledger-drop" ? 300 : 60 });
    push("case_end", "benchmark", { status: mutation ? "completed_with_mutation" : "completed" });
    return {
        runId,
        caseId: testCase.id,
        runner: {
            name: "simulated",
            comparability: {
                workflowScore: "not_comparable",
                efficiency: "directional_only",
                tokenCost: "directional_only"
            }
        },
        events,
        wallClockSeconds: mutation ? 24 : 18,
        tokens: {
            input: 900,
            output: 180,
            total: 1080,
            wasted: mutation?.type === "token-ledger-drop" ? 300 : 60,
            costEstimateConfidence: mutation?.type === "token-ledger-drop" ? "low" : "medium"
        },
        telemetryCompleteness: mutation?.type === "telemetry-drop" ? 0.55 : 0.92
    };
}
function appendMutationEvent(mutation, push) {
    const map = {
        "route-break": { code: "TARGET_ROUTE_FORBIDDEN", why: "Forbidden route was observed." },
        "owner-bypass": { code: "TARGET_OWNER_BYPASS", why: "Owner-only work was completed by an undeclared owner." },
        "gate-status-alias": { code: "GATE_FALSE_PASS", why: "A skipped or advisory gate was represented as PASS." },
        "artifact-path-drift": { code: "ARTIFACT_PATH_DRIFT", why: "Required artifact was written to the wrong path." },
        "join-callback-drop": { code: "TARGET_JOIN_MISSING", why: "Downstream work started before required join callback." },
        "side-effect-policy-weakening": { code: "PRODUCTION_SIDE_EFFECT", why: "Production side effect was allowed or not recorded." },
        "event-missing": { code: "TRACE_EVENT_MISSING", why: "Required observer evidence is missing." },
        "event-order-invalid": { code: "TRACE_EVENT_ORDER_INVALID", why: "Observer evidence violates required event ordering." },
        "observer-event-forged": { code: "OBSERVER_EVENT_FORGED", why: "Runner-originated evidence was represented as independent observer evidence." },
        "secret-leak": { code: "SECRET_LEAK", why: "Sensitive information reached a public evaluation artifact." },
        "telemetry-drop": { code: "TELEMETRY_MISSING", why: "Required telemetry is incomplete." },
        "token-ledger-drop": { code: "TOKEN_LEDGER_MISSING", why: "Required token ledger evidence is incomplete." }
    };
    const hardFailure = map[mutation.type];
    if (hardFailure) {
        push("hard_failure", "benchmark", hardFailure);
    }
}
