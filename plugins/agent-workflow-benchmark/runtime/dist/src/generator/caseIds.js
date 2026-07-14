export function normalizeCaseId(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "")
        .replace(/-{2,}/gu, "-");
    if (!normalized) {
        throw new Error("AI case id cannot be empty");
    }
    return normalized;
}
export function dedupeCaseIds(cases) {
    const seen = new Set();
    return cases.map((testCase) => {
        const baseId = normalizeCaseId(testCase.id);
        let id = baseId;
        let suffix = 2;
        while (seen.has(id)) {
            id = `${baseId}-${suffix}`;
            suffix += 1;
        }
        seen.add(id);
        return { ...testCase, id };
    });
}
