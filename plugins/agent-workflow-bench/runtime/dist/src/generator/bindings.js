import path from "node:path";
export function normalizeCaseBindings(contract, bindings, defaults = {}) {
    const normalized = { ...(bindings ?? {}) };
    const primaryRole = resolveRoleBinding(contract, bindings?.primaryRole ?? defaults.primaryRole);
    const owner = resolveOwnerBinding(contract, bindings?.owner ?? defaults.owner);
    const joinId = resolveJoinBinding(contract, bindings?.joinId ?? defaults.joinId);
    const artifactPath = resolveArtifactPathBinding(contract, bindings?.artifactPath ?? defaults.artifactPath);
    if (primaryRole) {
        normalized.primaryRole = primaryRole;
    }
    if (owner) {
        normalized.owner = owner;
    }
    if (joinId) {
        normalized.joinId = joinId;
    }
    if (artifactPath) {
        normalized.artifactPath = artifactPath;
    }
    return normalized;
}
export function resolveRoleBinding(contract, value) {
    if (!value) {
        return undefined;
    }
    const roleId = stripPrefix(value.trim(), "role:");
    return contract.roles.some((role) => role.id === roleId) ? roleId : undefined;
}
export function resolveOwnerBinding(contract, value) {
    if (!value) {
        return undefined;
    }
    const withoutOwnerPrefix = stripPrefix(value.trim(), "owner:");
    const ownerRole = contract.requiredOwners[withoutOwnerPrefix];
    if (ownerRole) {
        return ownerRole;
    }
    const ownerScopeRole = contract.roles.find((role) => role.ownerScopes.includes(withoutOwnerPrefix));
    if (ownerScopeRole) {
        return ownerScopeRole.id;
    }
    return resolveRoleBinding(contract, value);
}
export function resolveJoinBinding(contract, value) {
    if (!value) {
        return undefined;
    }
    const joinId = stripPrefix(value.trim(), "join:");
    if (joinId === "not-applicable") {
        return joinId;
    }
    const byId = contract.joins.find((join) => join.id === joinId);
    if (byId) {
        return byId.id;
    }
    const byArtifact = contract.joins.find((join) => join.artifact === joinId);
    return byArtifact?.id;
}
export function resolveArtifactPathBinding(contract, value) {
    if (!value) {
        return undefined;
    }
    const evidenceValue = stripKnownPrefix(value, ["artifact", "state", "path"]);
    const evidencePaths = [...contract.artifacts, ...contract.states];
    const byPath = evidencePaths.find((evidence) => evidence.path === evidenceValue);
    if (byPath) {
        return byPath.path;
    }
    const byId = evidencePaths.find((evidence) => evidence.id === evidenceValue);
    if (byId) {
        return byId.path;
    }
    const byUniqueBasename = evidencePaths.filter((evidence) => path.basename(evidence.path) === path.basename(evidenceValue));
    return byUniqueBasename.length === 1 ? byUniqueBasename[0].path : undefined;
}
function stripPrefix(value, prefix) {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
function stripKnownPrefix(value, prefixes) {
    const trimmed = value.trim();
    for (const prefix of prefixes) {
        const marker = `${prefix}:`;
        if (trimmed.startsWith(marker)) {
            return trimmed.slice(marker.length);
        }
    }
    return trimmed;
}
