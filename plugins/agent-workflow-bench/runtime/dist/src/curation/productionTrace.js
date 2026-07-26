import { PRODUCT_NAME } from "../core/product.js";
import { assertOtlpDiagnosticImportIntegrity, isSensitiveOtlpAttributeKey } from "../importers/otlp.js";
import { sha256Text, stableJson } from "../utils/hash.js";
import { redactSensitiveText } from "../utils/redaction.js";
export function buildProductionTraceCurationDraft(input) {
    validateInput(input);
    const replayCases = input.labels
        .map((label) => replayCase(label))
        .sort((left, right) => left.draftCaseId.localeCompare(right.draftCaseId));
    const eventLineage = replayCases.map((draft) => ({
        draftCaseId: draft.draftCaseId,
        sourceEventRefs: [...draft.sourceEventRefs],
        knownGoodEventRefs: [...draft.pairedKnownGoodCounterexample.sourceEventRefs],
        lineageHash: sha256Text(stableJson({
            sourceEventRefs: draft.sourceEventRefs,
            knownGoodEventRefs: draft.pairedKnownGoodCounterexample.sourceEventRefs
        }))
    }));
    const reportWithoutIntegrity = {
        schemaVersion: "0.1.0",
        artifactType: "production_trace_curation",
        product: PRODUCT_NAME,
        packageState: "DRAFT",
        status: "DIAGNOSTIC_ONLY",
        gateAuthority: "NONE",
        reasonCodes: [
            "DRAFT_ONLY_NO_GATE_AUTHORITY",
            "PRODUCTION_TRACE_REVIEW_REQUIRED"
        ],
        generatedAt: input.generatedAt,
        source: {
            ref: input.sourceImportRef,
            sha256: input.sourceImportHash,
            importContentHash: input.sourceImport.integrity.contentHash,
            mappingVersion: input.sourceImport.mappingVersion,
            sourceRef: input.sourceImport.source.ref,
            sourceSha256: input.sourceImport.source.sha256
        },
        taxonomy: {
            mappingVersion: input.taxonomy.mappingVersion,
            failureTaxonomyVersion: input.taxonomy.failureTaxonomyVersion,
            labelsVersion: input.taxonomy.labelsVersion
        },
        privacy: {
            consent: input.consent,
            retention: input.retention,
            redactionReview: input.redactionReview
        },
        lineage: {
            sourceImportHash: input.sourceImportHash,
            sourceImportContentHash: input.sourceImport.integrity.contentHash,
            dedupHash: sha256Text(stableJson({
                sourceImportHash: input.sourceImportHash,
                labels: input.labels.map((label) => ({
                    failureCode: label.failureCode,
                    sourceEventRefs: [...label.sourceEventRefs].sort(),
                    knownGoodEventRefs: [...label.knownGoodEventRefs].sort()
                }))
            })),
            eventLineage
        },
        replayCases,
        reviewRequirements: {
            ownerReviewRequired: true,
            ownerReviewers: [...input.ownerReview.requiredReviewers].sort(),
            ownerRequirement: input.ownerReview.requirement,
            securityReviewRequired: true,
            securityReviewers: [...input.securityReview.requiredReviewers].sort(),
            securityRequirement: input.securityReview.requirement
        },
        prerequisites: {
            referenceRun: {
                status: "REQUIRED",
                requirement: input.prerequisites.referenceRun.requirement
            },
            holdout: {
                status: "REQUIRED",
                requirement: input.prerequisites.holdout.requirement
            }
        },
        quarantine: {
            status: "NOT_QUARANTINED",
            reason: "No duplicate source hashes or privacy blockers detected."
        }
    };
    return {
        ...reportWithoutIntegrity,
        integrity: {
            status: "VERIFIED_AT_WRITE",
            contentHash: sha256Text(stableJson(reportWithoutIntegrity))
        }
    };
}
export function assertProductionTraceCurationIntegrity(report) {
    const { integrity, ...content } = report;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(content))) {
        throw new Error("Production trace curation integrity verification failed.");
    }
}
export function renderProductionTraceCurationMarkdown(report) {
    const cases = report.replayCases.map((entry) => `| ${entry.draftCaseId} | ${entry.severity} | ${entry.sourceFailureCode} | ${entry.workflowKind} |`);
    return [
        "# Production Trace Curation Draft",
        "",
        `Package state: ${report.packageState}`,
        `Status: ${report.status}`,
        `Gate authority: ${report.gateAuthority}`,
        `Source import: ${report.source.ref}`,
        "",
        "## Draft replay cases",
        "",
        "| case | severity | failure | workflow |",
        "| --- | --- | --- | --- |",
        ...(cases.length > 0
            ? cases
            : ["| none | none | none | none |"]),
        "",
        "## Required before any promotion",
        "",
        `- Owner review: ${report.reviewRequirements.ownerRequirement}`,
        `- Security review: ${report.reviewRequirements.securityRequirement}`,
        `- Reference run: ${report.prerequisites.referenceRun.requirement}`,
        `- Holdout isolation: ${report.prerequisites.holdout.requirement}`,
        "",
        "This package is a redacted diagnostic draft. It cannot activate cases, enter holdout labels, or affect a gate by itself."
    ].join("\n");
}
function validateInput(input) {
    if (input.requestedPackageState && input.requestedPackageState !== "DRAFT") {
        throw new Error("Production trace curation is draft-only and cannot be marked active.");
    }
    validateNoSensitiveValues(input.sourceImport);
    validateSourceImport(input);
    validatePrivacyMetadata(input);
    validateLabels(input);
    validateNoSensitiveValues(input.labels);
    validateNoSensitiveValues({
        consent: input.consent,
        retention: input.retention,
        redactionReview: input.redactionReview,
        ownerReview: input.ownerReview,
        securityReview: input.securityReview
    });
}
function validateSourceImport(input) {
    if (!isIsoTimestamp(input.generatedAt) ||
        !isPortableRef(input.sourceImportRef) ||
        input.sourceImport.schemaVersion !== "0.1.0" ||
        input.sourceImport.artifactType !== "otlp_diagnostic_import" ||
        input.sourceImport.mappingVersion !== "0.1.0" ||
        !isPortableRef(input.sourceImport.source?.ref) ||
        !isHash(input.sourceImport.source?.sha256) ||
        !Array.isArray(input.sourceImport.events) ||
        input.sourceImport.events.length === 0) {
        throw new Error("Production trace curation generatedAt or source import binding is invalid.");
    }
    if (input.sourceImport.status !== "DIAGNOSTIC_ONLY" ||
        input.sourceImport.gateAuthority !== "NONE") {
        throw new Error("Production trace curation requires a DIAGNOSTIC_ONLY source import with no gate authority.");
    }
    const { integrity, ...sourceContent } = input.sourceImport;
    if (integrity.status !== "VERIFIED_AT_WRITE" ||
        integrity.contentHash !== sha256Text(stableJson(sourceContent))) {
        throw new Error("Source import integrity verification failed.");
    }
    assertOtlpDiagnosticImportIntegrity(input.sourceImport);
    if (input.sourceImportHash !== sha256Text(stableJson(input.sourceImport))) {
        throw new Error("Source import hash does not match content.");
    }
    if (input.sourceImport.mappingVersion !== input.taxonomy.mappingVersion) {
        throw new Error("Source import mapping version must match taxonomy mapping version.");
    }
    const sourceHashes = [
        input.sourceImportHash,
        ...(input.additionalSourceImportHashes ?? [])
    ];
    if (sourceHashes.some((hash) => !isHash(hash))) {
        throw new Error("Production trace curation source hashes are invalid.");
    }
    if (new Set(sourceHashes).size !== sourceHashes.length) {
        throw new Error("Production trace curation rejects duplicate source hash inputs.");
    }
}
function validatePrivacyMetadata(input) {
    if (input.consent.scope !== "benchmark_curation_draft" ||
        !input.consent.grantedBy.trim() ||
        !input.consent.grantedAt.trim() ||
        !input.consent.expiresAt.trim() ||
        !input.consent.allowedUses.includes("diagnostic_replay_draft") ||
        input.consent.evidenceRefs.length === 0) {
        throw new Error("Production trace curation requires explicit consent evidence for diagnostic replay draft use.");
    }
    const generatedAt = Date.parse(input.generatedAt);
    const grantedAt = Date.parse(input.consent.grantedAt);
    const consentExpiresAt = Date.parse(input.consent.expiresAt);
    const retentionExpiresAt = Date.parse(input.retention.expiresAt);
    const reviewedAt = Date.parse(input.redactionReview.reviewedAt);
    if (!isIsoTimestamp(input.consent.grantedAt) ||
        !isIsoTimestamp(input.consent.expiresAt) ||
        !isIsoTimestamp(input.retention.expiresAt) ||
        !isIsoTimestamp(input.redactionReview.reviewedAt) ||
        grantedAt > generatedAt ||
        reviewedAt > generatedAt ||
        consentExpiresAt <= generatedAt ||
        retentionExpiresAt <= generatedAt) {
        throw new Error("Production trace curation consent, retention, or redaction review evidence is invalid or expired.");
    }
    for (const ref of [
        ...input.consent.evidenceRefs,
        input.retention.policyRef,
        ...input.redactionReview.evidenceRefs
    ]) {
        if (!isPortableRef(ref)) {
            throw new Error("Production trace curation privacy evidence refs must be portable.");
        }
    }
    if (!input.retention.policyRef.trim() || !input.retention.expiresAt.trim()) {
        throw new Error("Production trace curation requires retention policy and expiry evidence.");
    }
    if (input.redactionReview.redactedOnly !== true ||
        !input.redactionReview.reviewedBy.trim() ||
        !input.redactionReview.reviewedAt.trim() ||
        !input.redactionReview.policyVersion.trim() ||
        input.redactionReview.evidenceRefs.length === 0) {
        throw new Error("Production trace curation requires redaction review evidence.");
    }
    validateReviewRequirement(input.ownerReview, "owner");
    validateReviewRequirement(input.securityReview, "security");
    if (input.prerequisites.referenceRun.required !== true ||
        !input.prerequisites.referenceRun.requirement.trim() ||
        input.prerequisites.holdout.required !== true ||
        !input.prerequisites.holdout.requirement.trim()) {
        throw new Error("Production trace curation requires reference-run and holdout prerequisites.");
    }
}
function validateReviewRequirement(requirement, label) {
    if (requirement.requiredReviewers.length === 0 ||
        requirement.requiredReviewers.some((reviewer) => !reviewer.trim()) ||
        !requirement.requirement.trim()) {
        throw new Error(`Production trace curation requires ${label} review requirements.`);
    }
}
function validateLabels(input) {
    const sourceEventIds = input.sourceImport.events.map((event) => event.eventId);
    if (sourceEventIds.some((eventId) => !eventId?.trim()) ||
        new Set(sourceEventIds).size !== sourceEventIds.length) {
        throw new Error("Production trace curation source import contains a duplicate event id.");
    }
    const eventRefs = new Set(input.sourceImport.events.map((event) => `${input.sourceImportRef}#event=${event.eventId}`));
    if (input.labels.length === 0) {
        throw new Error("Production trace curation requires at least one failure label.");
    }
    const draftCaseIds = new Set();
    for (const label of input.labels) {
        const draftCaseId = `prod-draft-case-${kebab(label.failureCode)}`;
        if (!label.failureCode.trim() ||
            draftCaseId === "prod-draft-case-" ||
            draftCaseIds.has(draftCaseId) ||
            !label.category.trim() ||
            !label.workflowKind.trim() ||
            !label.expectedBehavior.trim() ||
            label.sourceEventRefs.length === 0) {
            throw new Error("Production trace curation labels require failure metadata and source event refs.");
        }
        draftCaseIds.add(draftCaseId);
        if (label.knownGoodEventRefs.length === 0) {
            throw new Error("Each production trace curation label requires a paired known-good counterexample.");
        }
        if (new Set(label.sourceEventRefs).size !== label.sourceEventRefs.length ||
            new Set(label.knownGoodEventRefs).size !==
                label.knownGoodEventRefs.length ||
            label.sourceEventRefs.some((ref) => label.knownGoodEventRefs.includes(ref))) {
            throw new Error("Production trace curation failure and known-good event refs must be unique and disjoint.");
        }
        for (const ref of [...label.sourceEventRefs, ...label.knownGoodEventRefs]) {
            if (!eventRefs.has(ref)) {
                throw new Error(`Production trace curation label references unknown source event ref: ${ref}`);
            }
        }
        validateMinimizedInputs(label.minimizedInputs, "minimized replay inputs");
        validateMinimizedInputs(label.knownGoodInputs, "known-good inputs");
    }
}
function validateMinimizedInputs(inputs, label) {
    if (Object.keys(inputs).length === 0) {
        throw new Error(`Production trace curation requires ${label}.`);
    }
    validateNoSensitiveValues(inputs);
}
function replayCase(label) {
    return {
        draftCaseId: `prod-draft-case-${kebab(label.failureCode)}`,
        packageState: "DRAFT",
        sourceFailureCode: label.failureCode,
        category: label.category,
        severity: label.severity,
        workflowKind: label.workflowKind,
        sourceEventRefs: [...label.sourceEventRefs].sort(),
        replayPrompt: {
            status: "MINIMIZED",
            variables: sortRecord(label.minimizedInputs),
            excludesRawProductionPayloads: true
        },
        pairedKnownGoodCounterexample: {
            sourceEventRefs: [...label.knownGoodEventRefs].sort(),
            variables: sortRecord(label.knownGoodInputs),
            excludesRawProductionPayloads: true
        },
        expectedBehavior: label.expectedBehavior
    };
}
function validateNoSensitiveValues(value) {
    if (containsDirectIdentifier(value)) {
        throw new Error("Production trace curation rejects direct customer or user identifiers.");
    }
    if (containsUnredactedSensitiveOtlpAttribute(value)) {
        throw new Error("Production trace curation rejects unredacted sensitive OTLP attributes.");
    }
    const serialized = stableJson(value);
    if (redactSensitiveText(serialized) !== serialized || containsCompanyPath(serialized)) {
        throw new Error("Production trace curation rejects unredacted sensitive values.");
    }
}
function containsUnredactedSensitiveOtlpAttribute(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveOtlpAttributeKey(key)) {
            if (isRedactedValue(item)) {
                continue;
            }
            return true;
        }
        if (containsUnredactedSensitiveOtlpAttribute(item)) {
            return true;
        }
    }
    return false;
}
function isRedactedValue(value) {
    if (typeof value === "string") {
        return value === "<redacted>" || value.trim().length === 0;
    }
    if (Array.isArray(value)) {
        return value.every(isRedactedValue);
    }
    if (value && typeof value === "object") {
        return Object.values(value).every(isRedactedValue);
    }
    return value === undefined || value === null;
}
function containsDirectIdentifier(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    for (const [key, item] of Object.entries(value)) {
        if (/^(?:customer|customerId|user|userId|account|accountId|email|phone)$/iu.test(key) &&
            item !== undefined &&
            item !== null &&
            (typeof item !== "string" || item.trim().length > 0)) {
            return true;
        }
        if (containsDirectIdentifier(item)) {
            return true;
        }
    }
    return false;
}
function containsCompanyPath(value) {
    const markers = ["company", "internal", ["san", "kuai"].join(""), ["mei", "tuan"].join("")];
    const markerPattern = markers.join("|");
    return new RegExp(String.raw `(?:^|[/"'])[^/"']*(?:${markerPattern})[^/"']*(?:\/|\\)[^"']*`, "iu").test(value);
}
function sortRecord(value) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
function kebab(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "");
}
function isHash(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
function isIsoTimestamp(value) {
    return (typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
        Number.isFinite(Date.parse(value)));
}
function isPortableRef(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        !value.startsWith("/") &&
        !/^[A-Za-z]:/u.test(value) &&
        !value.includes("\\") &&
        !value.includes("://") &&
        !value.split("/").includes(".."));
}
