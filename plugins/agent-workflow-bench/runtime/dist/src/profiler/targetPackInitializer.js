import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
const statusOrder = ["PASS", "FAILED", "SKIPPED", "ADVISORY", "PENDING", "BLOCKED", "READY"];
const knownScopes = ["triage", "dod", "implementation", "design", "architecture", "review", "qa", "testing", "planning"];
export async function inferTargetPackDraft(options) {
    const agentRoot = path.resolve(options.agentRoot);
    await assertDirectory(agentRoot);
    const roles = await inferRoles(agentRoot, options.targetId);
    if (roles.length === 0) {
        throw new Error(`No agent files found under ${agentRoot}`);
    }
    const entryRole = chooseEntrypointRole(roles);
    const statuses = inferStatuses(roles);
    const requiredOwners = inferRequiredOwners(roles, entryRole.id);
    const artifacts = inferEvidencePaths(roles, "artifact");
    const states = inferEvidencePaths(roles, "state");
    const joins = inferJoins(roles);
    const forbiddenArgs = inferForbiddenArgs(roles);
    const targetPack = {
        schemaVersion: "0.1.0",
        id: options.targetId,
        name: options.name ?? titleize(options.targetId),
        targetType: options.targetType ?? "directory",
        root: agentRoot,
        entrypoints: [
            {
                id: entryRole.id,
                kind: "file",
                path: entryRole.path
            }
        ],
        roles: roles.map(({ id, path: rolePath, ownerScopes }) => ({ id, path: rolePath, ownerScopes })),
        contracts: {
            statuses,
            requiredOwners,
            routing: { forbidden: [] },
            joins,
            artifacts,
            states,
            budgets: {
                wallClockSeconds: 120,
                tokenTotal: 12000
            }
        },
        commandPolicy: {
            allowedExecutables: ["node", "npm"],
            forbiddenArgs
        },
        contractReview: {
            status: "draft"
        }
    };
    return {
        targetPack,
        gapsMarkdown: renderGapsMarkdown(targetPack)
    };
}
async function assertDirectory(dir) {
    const info = await stat(dir);
    if (!info.isDirectory()) {
        throw new Error(`--agent-root must be a directory: ${dir}`);
    }
}
async function inferRoles(agentRoot, targetId) {
    const files = await fg(["AGENTS.md", "CLAUDE.md", "**/AGENTS.md", "**/CLAUDE.md", ".claude/agents/*.md", ".codex/agents/*.toml"], {
        cwd: agentRoot,
        dot: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"]
    });
    const uniqueFiles = [...new Set(files)].sort((left, right) => roleSortKey(left).localeCompare(roleSortKey(right)));
    const roles = await Promise.all(uniqueFiles.map(async (filePath) => {
        const text = await readFile(path.join(agentRoot, filePath), "utf8");
        const id = roleIdFromPath(filePath, targetId);
        return {
            id,
            path: filePath,
            ownerScopes: inferOwnerScopes(id, text),
            text
        };
    }));
    return dedupeRoles(roles);
}
function roleSortKey(filePath) {
    const id = roleIdFromPath(filePath, "target");
    if (id.includes("scrum-master") || id === "sm" || id.includes("orchestrator")) {
        return `0-${filePath}`;
    }
    if (filePath === "AGENTS.md" || filePath === "CLAUDE.md") {
        return `1-${filePath}`;
    }
    return `2-${filePath}`;
}
function roleIdFromPath(filePath, targetId) {
    const parsed = path.parse(filePath);
    const base = parsed.name.toLowerCase() === "agents" || parsed.name.toLowerCase() === "claude" ? path.basename(parsed.dir) || targetId : parsed.name;
    return normalizeId(base || targetId);
}
function inferOwnerScopes(roleId, text) {
    const roleHaystack = roleId.toLowerCase();
    const textHaystack = text.toLowerCase();
    const scopes = new Set();
    for (const phrase of textHaystack.matchAll(/\bowns?\s+([^.\n]+)/giu)) {
        const ownedText = phrase[1];
        for (const scope of knownScopes) {
            if (ownedText.includes(scope)) {
                scopes.add(scope === "testing" ? "qa" : scope === "architecture" ? "design" : scope);
            }
        }
    }
    for (const scope of knownScopes) {
        if (roleHaystack.includes(scope)) {
            scopes.add(scope === "testing" ? "qa" : scope === "architecture" ? "design" : scope);
        }
    }
    if (roleHaystack.includes("scrum") || textHaystack.includes("owns triage")) {
        scopes.add("triage");
    }
    if (roleHaystack.includes("dod") || textHaystack.includes("owns dod") || textHaystack.includes("owns definition of done")) {
        scopes.add("dod");
    }
    if (roleHaystack.includes("backend") || roleHaystack.includes("implementation") || roleHaystack.includes("code")) {
        scopes.add("implementation");
    }
    if (roleHaystack.includes("qa") || roleHaystack.includes("test")) {
        scopes.add("qa");
    }
    return [...scopes].sort();
}
function chooseEntrypointRole(roles) {
    return roles.find((role) => role.id.includes("scrum-master") || role.id.includes("orchestrator")) ?? roles[0];
}
function inferStatuses(roles) {
    const combined = roles.map((role) => role.text).join("\n");
    const found = new Set();
    for (const status of statusOrder) {
        if (new RegExp(`\\b${status}\\b`, "u").test(combined)) {
            found.add(status);
        }
    }
    if (/\bFAIL\b/u.test(combined)) {
        found.add("FAILED");
    }
    return found.size > 0 ? statusOrder.filter((status) => found.has(status)) : ["PASS", "FAILED", "SKIPPED", "ADVISORY"];
}
function inferRequiredOwners(roles, fallbackRoleId) {
    const owners = {};
    for (const role of roles) {
        for (const scope of role.ownerScopes) {
            owners[scope] ??= role.id;
        }
    }
    if (Object.keys(owners).length === 0) {
        owners.default = fallbackRoleId;
    }
    return owners;
}
function inferEvidencePaths(roles, kind) {
    const evidence = new Map();
    for (const role of roles) {
        for (const evidencePath of extractEvidencePaths(role.text)) {
            const isState = /(^|\/)(process|state|states|blocked|sprint)\//u.test(evidencePath) || /state|blocked/u.test(path.basename(evidencePath).toLowerCase());
            if ((kind === "state") !== isState) {
                continue;
            }
            evidence.set(evidencePath, {
                id: normalizeId(path.basename(evidencePath, path.extname(evidencePath))),
                path: evidencePath,
                owner: role.id
            });
        }
    }
    return [...evidence.values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((item) => (kind === "artifact" ? { id: item.id, path: item.path, owner: item.owner } : { id: item.id, path: item.path }));
}
function inferJoins(roles) {
    const joins = [];
    for (const role of roles) {
        const pattern = /return(?:s|ed)?\s+([A-Za-z0-9._/-]+\.(?:md|json|yaml|yml|txt))\s+to\s+([A-Za-z0-9._-]+)/giu;
        for (const match of role.text.matchAll(pattern)) {
            const artifact = normalizeEvidencePath(match[1]);
            const consumer = normalizeId(match[2]);
            joins.push({
                id: normalizeId(`${role.id}-${consumer}-join`),
                producer: role.id,
                consumer,
                artifact
            });
        }
    }
    return joins.sort((left, right) => left.id.localeCompare(right.id));
}
function inferForbiddenArgs(roles) {
    const args = new Set();
    for (const role of roles) {
        const pattern = /\b(?:never use|forbid(?:den)?|do not use)\s+([^\n.]+)/giu;
        for (const match of role.text.matchAll(pattern)) {
            for (const arg of match[1].match(/--[a-z0-9-]+/giu) ?? []) {
                args.add(arg);
            }
        }
    }
    return [...args].sort();
}
function extractEvidencePaths(text) {
    const output = new Set();
    const pattern = /(^|[\s`'"])([A-Za-z0-9._/-]+\.(?:md|json|yaml|yml|txt))(?=$|[\s`'",.;)])/giu;
    for (const match of text.matchAll(pattern)) {
        const evidencePath = normalizeEvidencePath(match[2]);
        if (!/^(AGENTS|CLAUDE)\.md$/iu.test(evidencePath)) {
            output.add(evidencePath);
        }
    }
    return [...output].sort();
}
function normalizeEvidencePath(value) {
    return value.replace(/^\.\/+/u, "").replace(/\\/gu, "/");
}
function dedupeRoles(roles) {
    const seen = new Set();
    return roles.filter((role) => {
        if (seen.has(role.id)) {
            return false;
        }
        seen.add(role.id);
        return true;
    });
}
function renderGapsMarkdown(targetPack) {
    const gaps = [
        `# Target Pack Draft: ${targetPack.id}`,
        "",
        "Review required before registering this target pack.",
        "",
        "## Inferred",
        "",
        `- roles: ${targetPack.roles.map((role) => role.id).join(", ")}`,
        `- entrypoint: ${targetPack.entrypoints[0]?.path ?? "unknown"}`,
        `- artifacts: ${targetPack.contracts.artifacts.length}`,
        `- states: ${targetPack.contracts.states.length}`,
        `- joins: ${targetPack.contracts.joins.length}`,
        "",
        "## Needs Owner Confirmation",
        "",
        "- Confirm required owner scopes and role ownership.",
        "- Confirm forbidden routes and handoff boundaries; static inference leaves routing.forbidden empty.",
        "- Confirm artifacts/states are canonical paths, not examples or aliases.",
        "- Confirm budgets and commandPolicy before using this target for release gates.",
        "- Produce a contract-validity artifact that binds the owner review to the final contractHash.",
        "- Move the reviewed draft to configs/targets/<target-id>.yaml and register it in configs/targets/registry.yaml."
    ];
    return `${gaps.join("\n")}\n`;
}
function normalizeId(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "")
        .replace(/-{2,}/gu, "-");
    return normalized || "agent";
}
function titleize(value) {
    return value
        .split(/[-_\s]+/u)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ");
}
