import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { TargetPack, TargetType } from "../core/types.js";

type TargetPackDraft = Omit<TargetPack, "configPath">;

interface InferredRole {
  id: string;
  path: string;
  ownerScopes: string[];
  text: string;
}

export interface InitTargetDraftOptions {
  agentRoot: string;
  targetId: string;
  name?: string;
  targetType?: TargetType;
}

export interface InitTargetDraftResult {
  targetPack: TargetPackDraft;
  gapsMarkdown: string;
}

const knownScopes = ["triage", "dod", "implementation", "design", "architecture", "review", "qa", "testing", "planning"];

export async function inferTargetPackDraft(options: InitTargetDraftOptions): Promise<InitTargetDraftResult> {
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
  const targetPack: TargetPackDraft = {
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

async function assertDirectory(dir: string): Promise<void> {
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new Error(`--agent-root must be a directory: ${dir}`);
  }
}

async function inferRoles(agentRoot: string, targetId: string): Promise<InferredRole[]> {
  const files = await fg(["AGENTS.md", "CLAUDE.md", "**/AGENTS.md", "**/CLAUDE.md", ".claude/agents/*.md", ".codex/agents/*.toml"], {
    cwd: agentRoot,
    dot: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"]
  });
  const uniqueFiles = [...new Set(files)].sort((left, right) => roleSortKey(left).localeCompare(roleSortKey(right)));
  const roles = await Promise.all(
    uniqueFiles.map(async (filePath) => {
      const text = await readFile(path.join(agentRoot, filePath), "utf8");
      const id = roleIdFromPath(filePath, targetId);
      return {
        id,
        path: filePath,
        ownerScopes: inferOwnerScopes(id, text),
        text
      };
    })
  );
  return dedupeRoles(roles);
}

function roleSortKey(filePath: string): string {
  if (filePath === "AGENTS.md" || filePath === "CLAUDE.md") {
    return `0-${filePath}`;
  }
  return `1-${filePath}`;
}

function roleIdFromPath(filePath: string, targetId: string): string {
  const parsed = path.parse(filePath);
  const base = parsed.name.toLowerCase() === "agents" || parsed.name.toLowerCase() === "claude" ? path.basename(parsed.dir) || targetId : parsed.name;
  return normalizeId(base || targetId);
}

function inferOwnerScopes(roleId: string, text: string): string[] {
  const roleHaystack = roleId.toLowerCase();
  const textHaystack = text.toLowerCase();
  const scopes = new Set<string>();
  for (const phrase of textHaystack.matchAll(/\bowns?\s+([^.\n]+)/giu)) {
    const ownedText = phrase[1]!;
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
  if (textHaystack.includes("owns triage")) {
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

function chooseEntrypointRole(roles: InferredRole[]): InferredRole {
  return roles[0]!;
}

function inferStatuses(roles: InferredRole[]): string[] {
  const combined = roles.map((role) => role.text).join("\n");
  const found = new Set<string>();
  const declaration =
    /\b(?:gate\s+|workflow\s+)?statuses?(?:\s+codes?)?\s*(?:[:=]|\bare\b)\s*([^\n.]+)/giu;
  for (const match of combined.matchAll(declaration)) {
    for (const code of match[1]!.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/gu) ?? []) {
      found.add(code);
    }
  }
  return [...found].sort();
}

function inferRequiredOwners(roles: InferredRole[], fallbackRoleId: string): Record<string, string> {
  const owners: Record<string, string> = {};
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

function inferEvidencePaths(roles: InferredRole[], kind: "artifact"): Array<{ id: string; path: string; owner: string }>;
function inferEvidencePaths(roles: InferredRole[], kind: "state"): Array<{ id: string; path: string }>;
function inferEvidencePaths(roles: InferredRole[], kind: "artifact" | "state"): Array<{ id: string; path: string; owner?: string }> {
  const evidence = new Map<string, { id: string; path: string; owner?: string }>();
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
    .map((item) => (kind === "artifact" ? { id: item.id, path: item.path, owner: item.owner! } : { id: item.id, path: item.path }));
}

function inferJoins(roles: InferredRole[]): Array<{ id: string; producer: string; consumer: string; artifact: string }> {
  const joins: Array<{ id: string; producer: string; consumer: string; artifact: string }> = [];
  for (const role of roles) {
    const pattern = /return(?:s|ed)?\s+([A-Za-z0-9._/-]+\.(?:md|json|yaml|yml|txt))\s+to\s+([A-Za-z0-9._-]+)/giu;
    for (const match of role.text.matchAll(pattern)) {
      const artifact = normalizeEvidencePath(match[1]!);
      const consumer = normalizeId(match[2]!);
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

function inferForbiddenArgs(roles: InferredRole[]): string[] {
  const args = new Set<string>();
  for (const role of roles) {
    const pattern = /\b(?:never use|forbid(?:den)?|do not use)\s+([^\n.]+)/giu;
    for (const match of role.text.matchAll(pattern)) {
      for (const arg of match[1]!.match(/--[a-z0-9-]+/giu) ?? []) {
        args.add(arg);
      }
    }
  }
  return [...args].sort();
}

function extractEvidencePaths(text: string): string[] {
  const output = new Set<string>();
  const pattern = /(^|[\s`'"])([A-Za-z0-9._/-]+\.(?:md|json|yaml|yml|txt))(?=$|[\s`'",.;)])/giu;
  for (const match of text.matchAll(pattern)) {
    const evidencePath = normalizeEvidencePath(match[2]!);
    if (!/^(AGENTS|CLAUDE)\.md$/iu.test(evidencePath)) {
      output.add(evidencePath);
    }
  }
  return [...output].sort();
}

function normalizeEvidencePath(value: string): string {
  return value.replace(/^\.\/+/u, "").replace(/\\/gu, "/");
}

function dedupeRoles(roles: InferredRole[]): InferredRole[] {
  const seen = new Set<string>();
  return roles.filter((role) => {
    if (seen.has(role.id)) {
      return false;
    }
    seen.add(role.id);
    return true;
  });
}

function renderGapsMarkdown(targetPack: TargetPackDraft): string {
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
    `- raw statuses: ${targetPack.contracts.statuses.join(", ") || "none inferred"}`,
    "",
    "## Needs Owner Confirmation",
    "",
    "- Confirm required owner scopes and role ownership.",
    "- Confirm forbidden routes and handoff boundaries; static inference leaves routing.forbidden empty.",
    "- Confirm artifacts/states are canonical paths, not examples or aliases.",
    "- Confirm owner-reviewed status semantics, scopes, blocking behavior, terminal behavior, and allowed transitions for every raw status code.",
    "- Confirm budgets and commandPolicy before using this target for release gates.",
    "- Produce a contract-validity artifact that binds the owner review to the final contractHash.",
    "- Move the reviewed draft to configs/targets/<target-id>.yaml and register it in configs/targets/registry.yaml."
  ];
  return `${gaps.join("\n")}\n`;
}

function normalizeId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .replace(/-{2,}/gu, "-");
  return normalized || "agent";
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
