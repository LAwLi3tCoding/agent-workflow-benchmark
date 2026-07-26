import { createHash, createPublicKey, KeyObject, verify, } from "node:crypto";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
export const PRODUCTION_CANARY_POLICY = {
    policyVersion: "1.0.0",
    minSampleCount: 30,
    maxFalsePositiveRate: 0.02,
    maxFalseNegativeRate: 0,
    maxFlakyRate: 0.05,
    maxRuntimeSecondsP95: 900,
    maxCostUsdP95: 10
};
export const PRODUCTION_CANARY_POLICY_HASH = sha256Text(stableJson(PRODUCTION_CANARY_POLICY));
export function validateProductionIsolationManifest(manifest) {
    if (!isRecord(manifest)) {
        return diagnosticIsolation("PROD_ISOLATION_MANIFEST_INVALID");
    }
    if (containsRunnerPrivateKeyExposure(manifest)) {
        return {
            status: "BLOCK",
            reasonCodes: ["PROD_RUNNER_PRIVATE_KEY_EXPOSURE"],
            reasons: [
                "Runner-facing isolation configuration contains forbidden private-key material or a private local path."
            ]
        };
    }
    const reasonCodes = [];
    if (manifest.schemaVersion !== "0.1.0" ||
        manifest.artifactType !== "production_isolation_manifest") {
        reasonCodes.push("PROD_ISOLATION_MANIFEST_INVALID");
    }
    if (manifest.boundary !== "linux_container" &&
        manifest.boundary !== "strong_sandbox") {
        reasonCodes.push("PROD_ISOLATION_BOUNDARY_INSUFFICIENT");
    }
    if (manifest.networkPolicy !== "deny_by_default" &&
        manifest.networkPolicy !== "explicit_allowlist") {
        reasonCodes.push("PROD_NETWORK_POLICY_INSUFFICIENT");
    }
    if (manifest.targetMount !== "read_only") {
        reasonCodes.push("PROD_TARGET_NOT_READ_ONLY");
    }
    if (manifest.runnerHome !== "ephemeral" ||
        manifest.runnerTmp !== "ephemeral") {
        reasonCodes.push("PROD_RUNNER_STATE_NOT_EPHEMERAL");
    }
    if (manifest.toolProxy !== "controlled") {
        reasonCodes.push("PROD_TOOL_PROXY_UNCONTROLLED");
    }
    if (manifest.observerProcess !== "external") {
        reasonCodes.push("PROD_OBSERVER_NOT_EXTERNAL");
    }
    const trustAnchor = recordAt(manifest, "trustAnchor");
    if (trustAnchor?.source !== "external" ||
        !isPublicKeyRef(trustAnchor.observerPublicKeyRef) ||
        !isPublicKeyRef(trustAnchor.qualificationAuthorityPublicKeyRef)) {
        reasonCodes.push("PROD_TRUST_ANCHOR_INVALID");
    }
    const runnerEnvironment = recordAt(manifest, "runnerEnvironment");
    if (runnerEnvironment?.HOME !== "workspace://ephemeral-home" ||
        runnerEnvironment.TMPDIR !== "workspace://ephemeral-tmp") {
        reasonCodes.push("PROD_RUNNER_ENVIRONMENT_INSUFFICIENT");
    }
    const retentionPolicy = recordAt(manifest, "retentionPolicy");
    if (retentionPolicy?.redactedOnly !== true ||
        retentionPolicy.encryptedAtRest !== true ||
        !Number.isInteger(retentionPolicy.maxDays) ||
        retentionPolicy.maxDays < 1 ||
        retentionPolicy.maxDays > 30) {
        reasonCodes.push("PROD_RETENTION_POLICY_INSUFFICIENT");
    }
    const checks = recordAt(manifest, "checks");
    for (const [field, code] of [
        ["directNetworkDenied", "PROD_NETWORK_CANARY_MISSING"],
        ["productionWriteDenied", "PROD_WRITE_CANARY_MISSING"],
        ["privateKeyUnreadableByRunner", "PROD_KEY_CANARY_MISSING"],
        ["observerTraceOutsideRunnerWorkspace", "PROD_OBSERVER_BOUNDARY_MISSING"]
    ]) {
        if (checks?.[field] !== true) {
            reasonCodes.push(code);
        }
    }
    const uniqueReasonCodes = [...new Set(reasonCodes)];
    return uniqueReasonCodes.length === 0
        ? {
            status: "PASS",
            reasonCodes: [],
            reasons: ["Strong production isolation controls are declared and canary-verified."]
        }
        : {
            status: "DIAGNOSTIC_ONLY",
            reasonCodes: uniqueReasonCodes,
            reasons: [
                "Production isolation evidence is incomplete or does not meet the frozen strong-isolation contract."
            ]
        };
}
export function assessProductionCiGate(input) {
    const bindings = {
        gatePolicyHash: input.gate.gatePolicy.policyHash,
        gateResultHash: sha256Text(stableJson(input.gate)),
        runtimeManifestHash: sha256Text(stableJson(input.runtimeManifest)),
        provenanceHash: sha256Text(stableJson(input.provenance)),
        isolationManifestHash: sha256Text(stableJson(input.isolationManifest)),
        canaryReportHash: sha256Text(stableJson(input.canary))
    };
    if (input.gate.decision === "BLOCK") {
        return productionResult(input.gate, bindings, "BLOCK", "PROD-GATE-BLOCK", "The evidence gate reported a blocking failure.");
    }
    const isolation = validateProductionIsolationManifest(input.isolationManifest);
    if (isolation.status === "BLOCK") {
        return productionResult(input.gate, bindings, "BLOCK", "PROD_RUNNER_PRIVATE_KEY_EXPOSURE", isolation.reasons[0]);
    }
    if (input.gate.decision !== "PASS" ||
        input.gate.ruleId !== "GATE-PASS" ||
        input.gate.comparisonIntegrity !== "VALID") {
        return productionResult(input.gate, bindings, "DIAGNOSTIC_ONLY", "PROD-GATE-NOT-PASS", "The evidence gate has not established a qualified PASS.");
    }
    if (isolation.status !== "PASS" ||
        input.provenance.conditions.isolation !== "read_only_sandbox" ||
        input.provenance.conditions.permissionMode !==
            "read_only_no_approval" ||
        input.provenance.conditions.environment.ci !== true) {
        return productionResult(input.gate, bindings, "DIAGNOSTIC_ONLY", "PROD-ISOLATION-INSUFFICIENT", "The run is not bound to a verified strong CI isolation boundary.");
    }
    if (!hasQualifiedIndependentObserver(input.runtimeManifest, input.provenance)) {
        return productionResult(input.gate, bindings, "DIAGNOSTIC_ONLY", "PROD-OBSERVER-UNQUALIFIED", "Production blocking requires matched independently qualified live workflow-trace evidence.");
    }
    if (!canaryMeetsProductionPolicy(input.canary, bindings.isolationManifestHash, bindings.gatePolicyHash)) {
        return productionResult(input.gate, bindings, "DIAGNOSTIC_ONLY", "PROD-CANARY-NOT-READY", "The observe-only canary is missing, unbound, undersized, unstable, or outside frozen thresholds.");
    }
    if (input.authorization === undefined) {
        return productionResult(input.gate, bindings, "DIAGNOSTIC_ONLY", "PROD-BLOCKING-NOT-AUTHORIZED", "Evidence is ready, but production blocking has not been explicitly authorized.");
    }
    const authorization = verifyBlockingAuthorization({
        authorization: input.authorization,
        trustedAuthorizationKey: input.trustedAuthorizationKey,
        gate: input.gate,
        bindings,
        now: input.now
    });
    if (!authorization.valid) {
        return productionResult(input.gate, bindings, "BLOCK", "PROD-AUTHORIZATION-INVALID", `The supplied production-blocking authorization is invalid, expired, untrusted, or bound to different evidence (${authorization.reasonCode ?? "AUTHORIZATION_INVALID"}).`);
    }
    return {
        ...productionResult(input.gate, {
            ...bindings,
            authorizationId: authorization.authorizationId
        }, "PASS", "PROD-BLOCKING-AUTHORIZED", "Qualified evidence, strong isolation, canary thresholds, and explicit authorization are all valid."),
        productionBlockingEnabled: true,
        enforcementMode: "production_blocking"
    };
}
export const assessProductionReadiness = assessProductionCiGate;
export function prepareProductionBlockingAuthorization(input) {
    const prerequisiteAssessment = assessProductionCiGate({
        gate: input.gate,
        runtimeManifest: input.runtimeManifest,
        provenance: input.provenance,
        isolationManifest: input.isolationManifest,
        canary: input.canary
    });
    if (prerequisiteAssessment.decision !== "DIAGNOSTIC_ONLY" ||
        prerequisiteAssessment.ruleId !== "PROD-BLOCKING-NOT-AUTHORIZED" ||
        prerequisiteAssessment.productionBlockingEnabled) {
        throw new Error(`Production authorization cannot be prepared before all prerequisites pass (${prerequisiteAssessment.ruleId}).`);
    }
    if (!/^authority:\/\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.authorizedBy)) {
        throw new Error("Production authorization authority identifier is invalid.");
    }
    const authorizedAt = Date.parse(input.authorizedAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(authorizedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= authorizedAt) {
        throw new Error("Production authorization time window is invalid.");
    }
    const authorityPublicKey = resolveAuthorizationPublicKey(input.authorityPublicKey);
    const authorityFingerprint = authorizationKeyFingerprint(authorityPublicKey);
    const authorizationBase = {
        schemaVersion: "0.1.0",
        artifactType: "production_blocking_authorization",
        authorizedBy: input.authorizedBy,
        authorizedAt: input.authorizedAt,
        expiresAt: input.expiresAt,
        scope: {
            targetId: input.gate.targetId,
            suite: input.gate.suite
        },
        canaryReportHash: prerequisiteAssessment.bindings.canaryReportHash,
        isolationManifestHash: prerequisiteAssessment.bindings.isolationManifestHash,
        gateResultHash: prerequisiteAssessment.bindings.gateResultHash,
        runtimeManifestHash: prerequisiteAssessment.bindings.runtimeManifestHash,
        provenanceHash: prerequisiteAssessment.bindings.provenanceHash,
        gatePolicyHash: prerequisiteAssessment.bindings.gatePolicyHash,
        decision: "enable_blocking"
    };
    const unsignedAuthorization = {
        ...authorizationBase,
        authorizationId: sha256Text(stableJson(authorizationBase)),
        attestation: {
            algorithm: "ed25519",
            authorityFingerprint
        }
    };
    const requestWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "production_blocking_authorization_request",
        status: "AWAITING_HUMAN_SIGNATURE",
        generatedAt: input.authorizedAt,
        prerequisiteAssessment,
        unsignedAuthorization,
        signingPayloadHash: sha256Text(stableJson(unsignedAuthorization)),
        humanCheckpoint: {
            required: true,
            action: "externally_sign_payload",
            keyCustody: "external_only"
        }
    };
    return {
        ...requestWithoutIntegrity,
        integrity: {
            contentHash: sha256Text(stableJson(requestWithoutIntegrity))
        }
    };
}
export function finalizeProductionBlockingAuthorization(request, signatureBase64, trustedAuthorizationKey) {
    const { integrity, ...requestWithoutIntegrity } = request;
    if (integrity.contentHash !==
        sha256Text(stableJson(requestWithoutIntegrity)) ||
        request.signingPayloadHash !==
            sha256Text(stableJson(request.unsignedAuthorization))) {
        throw new Error("Production authorization request integrity is invalid.");
    }
    const publicKey = resolveAuthorizationPublicKey(trustedAuthorizationKey);
    if (request.unsignedAuthorization.attestation.authorityFingerprint !==
        authorizationKeyFingerprint(publicKey)) {
        throw new Error("Production authorization request authority fingerprint is invalid.");
    }
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length === 0 ||
        signature.toString("base64") !== signatureBase64 ||
        !verify(null, Buffer.from(stableJson(request.unsignedAuthorization)), publicKey, signature)) {
        throw new Error("The external authorization signature is invalid.");
    }
    return {
        ...request.unsignedAuthorization,
        attestation: {
            ...request.unsignedAuthorization.attestation,
            signature: signatureBase64
        }
    };
}
function canaryMeetsProductionPolicy(value, isolationManifestHash, gatePolicyHash) {
    if (!isRecord(value) ||
        value.schemaVersion !== "0.1.0" ||
        value.artifactType !== "production_canary_report" ||
        value.mode !== "observe_only" ||
        value.status !== "PASS" ||
        value.policyVersion !== PRODUCTION_CANARY_POLICY.policyVersion ||
        value.policyHash !== PRODUCTION_CANARY_POLICY_HASH ||
        !isHash(value.sampleSetHash) ||
        value.isolationManifestHash !== isolationManifestHash ||
        value.gatePolicyHash !== gatePolicyHash ||
        !isNonNegativeInteger(value.expectedPassCount) ||
        !isNonNegativeInteger(value.expectedBlockCount) ||
        !isNonNegativeInteger(value.sampleCount) ||
        value.sampleCount !== value.expectedPassCount + value.expectedBlockCount ||
        value.expectedPassCount === 0 ||
        value.expectedBlockCount === 0 ||
        value.sampleCount < PRODUCTION_CANARY_POLICY.minSampleCount ||
        !isNonNegativeInteger(value.falsePositiveCount) ||
        !isNonNegativeInteger(value.falseNegativeCount) ||
        !isNonNegativeInteger(value.flakyCaseCount) ||
        value.falsePositiveCount > value.expectedPassCount ||
        value.falseNegativeCount > value.expectedBlockCount ||
        value.flakyCaseCount > value.sampleCount ||
        value.falsePositiveRate !==
            roundRate(value.falsePositiveCount, value.expectedPassCount) ||
        value.falseNegativeRate !==
            roundRate(value.falseNegativeCount, value.expectedBlockCount) ||
        value.flakyRate !== roundRate(value.flakyCaseCount, value.sampleCount) ||
        !isFiniteNonNegative(value.runtimeSecondsP95) ||
        !isFiniteNonNegative(value.costUsdP95) ||
        value.retentionDecision !== "retain_redacted" ||
        typeof value.generatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.generatedAt))) {
        return false;
    }
    return (value.falsePositiveCount / value.expectedPassCount <=
        PRODUCTION_CANARY_POLICY.maxFalsePositiveRate &&
        value.falseNegativeCount / value.expectedBlockCount <=
            PRODUCTION_CANARY_POLICY.maxFalseNegativeRate &&
        value.flakyCaseCount / value.sampleCount <=
            PRODUCTION_CANARY_POLICY.maxFlakyRate &&
        value.runtimeSecondsP95 <=
            PRODUCTION_CANARY_POLICY.maxRuntimeSecondsP95 &&
        value.costUsdP95 <= PRODUCTION_CANARY_POLICY.maxCostUsdP95);
}
function hasQualifiedIndependentObserver(runtime, provenance) {
    const runtimeObserver = runtime.workflowTrace?.observer;
    const provenanceObserver = provenance.conditions.observer;
    return Boolean(runtime.runner.executionMode === "live" &&
        runtime.workflowTrace?.verified === true &&
        runtimeObserver?.qualificationStatus === "valid" &&
        runtimeObserver.qualificationRef ===
            "observer-qualification.json" &&
        runtimeObserver.qualificationArtifactHash &&
        runtimeObserver.qualificationAuthorityFingerprint &&
        provenance.conditions.executionMode === "live" &&
        provenance.conditions.evidenceKind === "live" &&
        provenance.conditions.observationLevel === "workflow_trace" &&
        provenanceObserver?.qualificationStatus === "valid" &&
        provenanceObserver.qualificationRef ===
            "observer-qualification.json" &&
        runtime.attemptId === provenance.subject.attemptId &&
        runtime.contractHash === provenance.subject.contractHash &&
        runtimeObserver.id === provenanceObserver.id &&
        runtimeObserver.version === provenanceObserver.version &&
        runtimeObserver.keyFingerprint === provenanceObserver.keyFingerprint &&
        runtimeObserver.qualificationArtifactHash ===
            provenanceObserver.qualificationArtifactHash &&
        runtimeObserver.qualificationAuthorityFingerprint ===
            provenanceObserver.qualificationAuthorityFingerprint);
}
function verifyBlockingAuthorization(input) {
    if (!isRecord(input.authorization) ||
        input.trustedAuthorizationKey === undefined) {
        return { valid: false, reasonCode: "AUTHORIZATION_OR_TRUST_KEY_MISSING" };
    }
    const authorization = input.authorization;
    const scope = recordAt(authorization, "scope");
    const attestation = recordAt(authorization, "attestation");
    if (authorization.schemaVersion !== "0.1.0" ||
        authorization.artifactType !==
            "production_blocking_authorization" ||
        authorization.decision !== "enable_blocking" ||
        typeof authorization.authorizationId !== "string" ||
        typeof authorization.authorizedBy !== "string" ||
        !authorization.authorizedBy.startsWith("authority://") ||
        typeof authorization.authorizedAt !== "string" ||
        typeof authorization.expiresAt !== "string" ||
        scope?.targetId !== input.gate.targetId ||
        scope.suite !== input.gate.suite ||
        authorization.canaryReportHash !==
            input.bindings.canaryReportHash ||
        authorization.isolationManifestHash !==
            input.bindings.isolationManifestHash ||
        authorization.gateResultHash !== input.bindings.gateResultHash ||
        authorization.runtimeManifestHash !==
            input.bindings.runtimeManifestHash ||
        authorization.provenanceHash !== input.bindings.provenanceHash ||
        authorization.gatePolicyHash !== input.bindings.gatePolicyHash ||
        attestation?.algorithm !== "ed25519" ||
        typeof attestation.authorityFingerprint !== "string" ||
        typeof attestation.signature !== "string") {
        return { valid: false, reasonCode: "AUTHORIZATION_SHAPE_OR_BINDING_INVALID" };
    }
    const authorizedAt = Date.parse(authorization.authorizedAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    const now = Date.parse(input.now ?? new Date().toISOString());
    if (!Number.isFinite(authorizedAt) ||
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(now) ||
        authorizedAt > now ||
        expiresAt <= now ||
        expiresAt <= authorizedAt) {
        return { valid: false, reasonCode: "AUTHORIZATION_TIME_INVALID" };
    }
    let publicKey;
    try {
        if (input.trustedAuthorizationKey instanceof KeyObject) {
            if (input.trustedAuthorizationKey.type !== "public") {
                return {
                    valid: false,
                    reasonCode: "AUTHORIZATION_PRIVATE_TRUST_KEY"
                };
            }
            publicKey = input.trustedAuthorizationKey;
        }
        else {
            const keyText = Buffer.isBuffer(input.trustedAuthorizationKey)
                ? input.trustedAuthorizationKey.toString("utf8")
                : input.trustedAuthorizationKey;
            if (keyText.includes(["PRIVATE", "KEY"].join(" "))) {
                return { valid: false, reasonCode: "AUTHORIZATION_PRIVATE_TRUST_KEY" };
            }
            publicKey = createPublicKey(input.trustedAuthorizationKey);
        }
    }
    catch {
        return { valid: false, reasonCode: "AUTHORIZATION_TRUST_KEY_INVALID" };
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
        return { valid: false, reasonCode: "AUTHORIZATION_TRUST_KEY_TYPE_INVALID" };
    }
    const authorityFingerprint = `sha256:${createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")}`;
    if (authorityFingerprint !== attestation.authorityFingerprint) {
        return { valid: false, reasonCode: "AUTHORIZATION_FINGERPRINT_MISMATCH" };
    }
    const authorizationBase = {
        schemaVersion: authorization.schemaVersion,
        artifactType: authorization.artifactType,
        authorizedBy: authorization.authorizedBy,
        authorizedAt: authorization.authorizedAt,
        expiresAt: authorization.expiresAt,
        scope,
        canaryReportHash: authorization.canaryReportHash,
        isolationManifestHash: authorization.isolationManifestHash,
        gateResultHash: authorization.gateResultHash,
        runtimeManifestHash: authorization.runtimeManifestHash,
        provenanceHash: authorization.provenanceHash,
        gatePolicyHash: authorization.gatePolicyHash,
        decision: authorization.decision
    };
    if (authorization.authorizationId !==
        sha256Text(stableJson(authorizationBase))) {
        return { valid: false, reasonCode: "AUTHORIZATION_ID_INVALID" };
    }
    const unsigned = {
        ...authorizationBase,
        authorizationId: authorization.authorizationId,
        attestation: {
            algorithm: attestation.algorithm,
            authorityFingerprint: attestation.authorityFingerprint
        }
    };
    let signature;
    try {
        signature = Buffer.from(attestation.signature, "base64");
    }
    catch {
        return { valid: false, reasonCode: "AUTHORIZATION_SIGNATURE_ENCODING_INVALID" };
    }
    const signatureValid = signature.length > 0 &&
        verify(null, Buffer.from(stableJson(unsigned)), publicKey, signature);
    return signatureValid
        ? {
            valid: true,
            authorizationId: authorization.authorizationId
        }
        : { valid: false, reasonCode: "AUTHORIZATION_SIGNATURE_INVALID" };
}
function resolveAuthorizationPublicKey(value) {
    let publicKey;
    try {
        if (value instanceof KeyObject) {
            if (value.type !== "public") {
                throw new Error("private key");
            }
            publicKey = value;
        }
        else {
            const keyText = Buffer.isBuffer(value)
                ? value.toString("utf8")
                : value;
            if (keyText.includes(["PRIVATE", "KEY"].join(" "))) {
                throw new Error("private key");
            }
            publicKey = createPublicKey(value);
        }
    }
    catch {
        throw new Error("Production authorization requires an external Ed25519 public key.");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Production authorization requires an external Ed25519 public key.");
    }
    return publicKey;
}
function authorizationKeyFingerprint(publicKey) {
    return `sha256:${createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")}`;
}
function productionResult(gate, bindings, decision, ruleId, reason) {
    return {
        schemaVersion: "0.1.0",
        artifactType: "production_ci_gate_result",
        decision,
        ruleId,
        productionBlockingEnabled: false,
        enforcementMode: "observe_only",
        evidenceDecision: gate.decision,
        reasons: [reason],
        bindings
    };
}
function containsRunnerPrivateKeyExposure(manifest) {
    const runnerEnvironment = recordAt(manifest, "runnerEnvironment");
    for (const [key, value] of Object.entries(runnerEnvironment ?? {})) {
        if (/(private|secret|token|credential|signing|observer.*key|key.*observer)/iu.test(key) ||
            (typeof value === "string" &&
                (value.includes(["PRIVATE", "KEY"].join(" ")) ||
                    redactSensitiveText(value) !== value))) {
            return true;
        }
    }
    const retainedArtifacts = Array.isArray(manifest.retainedArtifacts)
        ? manifest.retainedArtifacts
        : [];
    for (const artifact of retainedArtifacts) {
        if (!isRecord(artifact)) {
            continue;
        }
        for (const value of Object.values(artifact)) {
            if (typeof value === "string" &&
                (value.includes(["PRIVATE", "KEY"].join(" ")) ||
                    redactSensitiveText(value) !== value)) {
                return true;
            }
        }
    }
    return false;
}
function roundRate(count, total) {
    return total === 0 ? 0 : Number((count / total).toFixed(6));
}
function isPublicKeyRef(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        !/private|secret|credential/iu.test(value) &&
        !pathLooksPrivate(value));
}
function isHash(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
function pathLooksPrivate(value) {
    return redactSensitiveText(value) !== value;
}
function diagnosticIsolation(reasonCode) {
    return {
        status: "DIAGNOSTIC_ONLY",
        reasonCodes: [reasonCode],
        reasons: [
            "Production isolation manifest is missing or structurally invalid."
        ]
    };
}
function recordAt(value, key) {
    const candidate = value[key];
    return isRecord(candidate) ? candidate : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}
function isFiniteNonNegative(value) {
    return (typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0);
}
