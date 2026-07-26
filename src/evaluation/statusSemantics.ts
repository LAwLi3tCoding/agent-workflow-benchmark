import type {
  ContractModel,
  StatusSemantic,
  StatusSemanticClass
} from "../core/types.js";

export interface ContractMappingDiagnostic {
  code: "CONTRACT_MAPPING_MISSING";
  statusCodes: string[];
}

export function statusMappingDiagnostics(
  contract: Pick<ContractModel, "statuses" | "statusSemantics">
): ContractMappingDiagnostic[] {
  const mappings = contract.statusSemantics;
  if (contract.statuses.length === 0 && (!mappings || mappings.length === 0)) {
    return [];
  }
  if (!mappings || mappings.length === 0) {
    return [
      {
        code: "CONTRACT_MAPPING_MISSING",
        statusCodes: [...contract.statuses]
      }
    ];
  }

  const declared = new Set(contract.statuses);
  const invalid = new Set<string>();
  const mapped = new Set<string>();
  const scopedCodes = new Set<string>();
  const availableScopedCodes = new Set(
    mappings.map((mapping) => `${mapping.scope}\u0000${mapping.code}`)
  );

  for (const mapping of mappings) {
    const scopedCode = `${mapping.scope}\u0000${mapping.code}`;
    if (scopedCodes.has(scopedCode)) {
      invalid.add(mapping.code);
    }
    scopedCodes.add(scopedCode);

    if (!declared.has(mapping.code)) {
      invalid.add(mapping.code);
    } else {
      mapped.add(mapping.code);
    }
    if (mapping.terminal && mapping.allowedTransitions.length > 0) {
      invalid.add(mapping.code);
    }
    const invalidTransitions = mapping.allowedTransitions.filter(
      (code) =>
        !declared.has(code) ||
        !availableScopedCodes.has(`${mapping.scope}\u0000${code}`)
    );
    if (invalidTransitions.length > 0) {
      invalid.add(mapping.code);
      for (const code of invalidTransitions) {
        invalid.add(code);
      }
    }
  }

  for (const code of contract.statuses) {
    if (!mapped.has(code)) {
      invalid.add(code);
    }
  }

  if (invalid.size === 0) {
    return [];
  }

  return [
    {
      code: "CONTRACT_MAPPING_MISSING",
      statusCodes: orderedCodes(contract.statuses, invalid)
    }
  ];
}

export function resolveStatusSemantic(
  contract: Pick<ContractModel, "statusSemantics">,
  code: string,
  scope?: string
): StatusSemantic | undefined {
  const mappings = contract.statusSemantics ?? [];
  if (scope) {
    const scoped = mappings.filter(
      (mapping) => mapping.code === code && mapping.scope === scope
    );
    return scoped.length === 1 ? scoped[0] : undefined;
  }

  const matches = mappings.filter((mapping) => mapping.code === code);
  return matches.length === 1 ? matches[0] : undefined;
}

export function statusCodeForSemantic(
  contract: Pick<ContractModel, "statusSemantics">,
  semanticClass: StatusSemanticClass,
  scope?: string
): string | undefined {
  const matches = (contract.statusSemantics ?? []).filter(
    (mapping) =>
      mapping.semanticClass === semanticClass &&
      (!scope || mapping.scope === scope)
  );
  return matches.length === 1 ? matches[0]!.code : undefined;
}

export function scopesWithPassAndNonPassSemantics(
  contract: Pick<ContractModel, "statuses" | "statusSemantics">
): string[] {
  if (statusMappingDiagnostics(contract).length > 0) {
    return [];
  }
  const byScope = new Map<string, StatusSemantic[]>();
  for (const mapping of contract.statusSemantics ?? []) {
    const mappings = byScope.get(mapping.scope) ?? [];
    mappings.push(mapping);
    byScope.set(mapping.scope, mappings);
  }
  return [...byScope.entries()]
    .filter(([, mappings]) => {
      const passCount = mappings.filter(
        (mapping) => mapping.semanticClass === "pass"
      ).length;
      return (
        passCount === 1 &&
        mappings.some((mapping) => mapping.semanticClass !== "pass")
      );
    })
    .map(([scope]) => scope)
    .sort();
}

export function isFalsePassTransition(
  contract: Pick<ContractModel, "statusSemantics">,
  payload: Record<string, unknown>
): boolean {
  const status = stringValue(payload.status);
  const sourceStatus = stringValue(payload.sourceStatus);
  const scope = stringValue(payload.scope);
  const flowDecision = stringValue(payload.flowDecision);
  const readbackStatus = stringValue(payload.readbackStatus);
  const transition = objectValue(payload.transition);

  if (
    !status ||
    !sourceStatus ||
    !scope ||
    !flowDecision ||
    readbackStatus !== status ||
    stringValue(transition?.from) !== sourceStatus ||
    stringValue(transition?.to) !== status
  ) {
    return false;
  }

  const resolvedStatus = resolveStatusSemantic(contract, status, scope);
  const resolvedSource = resolveStatusSemantic(contract, sourceStatus, scope);
  return (
    resolvedStatus?.semanticClass === "pass" &&
    resolvedSource !== undefined &&
    resolvedSource.semanticClass !== "pass" &&
    !resolvedSource.allowedTransitions.includes(status)
  );
}

function orderedCodes(declared: string[], selected: Set<string>): string[] {
  const ordered = declared.filter((code) => selected.has(code));
  const extras = [...selected]
    .filter((code) => !declared.includes(code))
    .sort();
  return [...ordered, ...extras];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
