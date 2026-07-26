export function humanConfirmationMetadata() {
  return {
    assistanceDisclosure: "agent_prelabels_reviewed" as const,
    raters: [
      {
        raterId: "rater-a",
        role: "workflow_owner" as const,
        confirmation: {
          status: "confirmed_by_human" as const,
          method: "external_approval" as const,
          artifactRef: "external://human-confirmation/rater-a",
          artifactHash: humanLabelHash("rater-a")
        }
      },
      {
        raterId: "rater-b",
        role: "independent_reviewer" as const,
        confirmation: {
          status: "confirmed_by_human" as const,
          method: "external_approval" as const,
          artifactRef: "external://human-confirmation/rater-b",
          artifactHash: humanLabelHash("rater-b")
        }
      }
    ]
  };
}

function humanLabelHash(value: string): string {
  return `sha256:${Buffer.from(value)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64)}`;
}
