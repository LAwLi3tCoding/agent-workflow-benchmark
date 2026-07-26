import path from "node:path";
export function normalizeHealthGateEligibility(value) {
    if (value === "ELIGIBLE" ||
        value === "DIAGNOSTIC_ONLY" ||
        value === "BLOCK") {
        return value;
    }
    return "BLOCK";
}
export function shouldIncludeRuntimeDigestPath(relativePath) {
    const portablePath = relativePath.replaceAll("\\", "/");
    return (portablePath !== "node_modules" &&
        !portablePath.startsWith("node_modules/"));
}
export function portableCommandValue(value, options) {
    if (!path.isAbsolute(value)) {
        return value;
    }
    for (const tempRoot of options.tempRoots) {
        if (isAtOrBelow(value, tempRoot)) {
            return "<ephemeral-temp-path>";
        }
    }
    if (isAtOrBelow(value, options.repoRoot)) {
        const relative = path.relative(options.repoRoot, value);
        return relative
            ? relative.split(path.sep).join("/")
            : ".";
    }
    return "<external-path>";
}
export function redactPublicCommandText(value, options) {
    let output = value.replaceAll(options.repoRoot, "<repo>");
    if (!isAtOrBelow(options.outputRoot, options.repoRoot)) {
        output = output.replaceAll(options.outputRoot, "<output>");
    }
    for (const tempRoot of options.tempRoots) {
        output = output.replaceAll(tempRoot, "<ephemeral-temp>");
    }
    return output.replace(/BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?END [A-Z ]*PRIVATE KEY/gu, "<redacted-private-key>");
}
function isAtOrBelow(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)));
}
