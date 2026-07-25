const SECRET_VALUE = "<redacted>";
const EMAIL_VALUE = "<email>";
const PATH_VALUE = "<absolute-path>";
export function redactSensitiveText(value, options = {}) {
    let redacted = value;
    for (const sensitiveValue of [...(options.values ?? [])].sort((left, right) => right.length - left.length)) {
        if (sensitiveValue.length >= 8) {
            redacted = redacted.replaceAll(sensitiveValue, SECRET_VALUE);
        }
    }
    for (const sensitivePath of options.paths ?? []) {
        if (sensitivePath) {
            redacted = redacted.replace(new RegExp(escapeRegExp(sensitivePath), "gu"), PATH_VALUE);
        }
    }
    return redacted
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b/giu, `Bearer ${SECRET_VALUE}`)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, SECRET_VALUE)
        .replace(/\bAKIA[0-9A-Z]{16}\b/gu, SECRET_VALUE)
        .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|authorization|cookie)["']\s*:\s*["'])[^"']*(["'])/giu, `$1${SECRET_VALUE}$2`)
        .replace(/(\b(?:[A-Z][A-Z0-9_]*_)?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*)["']?[^\s,;"'}]+/giu, `$1${SECRET_VALUE}`)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, EMAIL_VALUE)
        .replace(/(?:\/Users\/|\/home\/|\/private\/(?:tmp|var)\/|\/var\/folders\/|\/tmp\/)[^\s"'<>),\]}]+/gu, PATH_VALUE)
        .replace(/(?<![:/\w])\/(?!\/)(?:[^/\s"'<>),\]}]+\/)+[^/\s"'<>),\]}]+/gu, PATH_VALUE)
        .replace(/\b[A-Z]:\\(?:[^\\\s"'<>),\]}]+\\)+[^\\\s"'<>),\]}]+/giu, PATH_VALUE);
}
export function publicAiCasePlan(plan, options = {}) {
    return redactStructuredValue(plan, options);
}
export function profileEvidenceSensitiveValues(evidence) {
    if (!evidence) {
        return [];
    }
    const values = new Set();
    for (const file of evidence.scannedFiles) {
        if (!file.excerpt) {
            continue;
        }
        values.add(file.excerpt);
        for (const line of file.excerpt.split(/\r?\n/gu)) {
            const trimmed = line.trim();
            if (trimmed.length >= 12) {
                values.add(trimmed);
            }
        }
    }
    return [...values];
}
export function publicProfileEvidence(evidence) {
    return {
        schemaVersion: "0.1.0",
        artifactType: "profile_evidence",
        targetId: evidence.targetId,
        root: evidence.root,
        scannedFiles: evidence.scannedFiles.map(({ excerpt: _excerpt, ...file }) => file),
        missingFiles: evidence.missingFiles,
        warnings: evidence.warnings
    };
}
function redactStructuredValue(value, options) {
    if (typeof value === "string") {
        return redactSensitiveText(value, options);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactStructuredValue(item, options));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStructuredValue(item, options)]));
    }
    return value;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
