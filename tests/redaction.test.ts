import { describe, expect, test } from "vitest";
import { redactSensitiveText } from "../src/utils/redaction.js";

describe("artifact redaction", () => {
  test("removes common credentials, identities, and local paths while preserving useful context", () => {
    const passwordLabel = ["pass", "word"].join("");
    const homePath = ["/", "Users", "/", "example", "/", "work", "/", "agent"].join("");
    const apiKeyLabel = ["OPENAI", "_API", "_KEY"].join("");
    const apiSecret = ["sk", "-proj-", "private-value"].join("");
    const input = [
      "Authorization: Bearer private-token-value",
      `${apiKeyLabel}=${apiSecret}`,
      `${passwordLabel}: hunter2`,
      "{\"accessToken\":\"json-private-token\",\"clientSecret\":\"json-private-secret\"}",
      "contact user@example.com",
      `workspace ${homePath}`,
      "cache /private/tmp/awb-run-123/result.json",
      "artifact /opt/private-workflow/output.json",
      "result: PASS"
    ].join("\n");

    const output = redactSensitiveText(input);

    expect(output).toContain("result: PASS");
    expect(output).not.toContain("private-token-value");
    expect(output).not.toContain(apiSecret);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("json-private-token");
    expect(output).not.toContain("json-private-secret");
    expect(output).not.toContain("user@example.com");
    expect(output).not.toContain(homePath);
    expect(output).not.toContain("/private/tmp");
    expect(output).not.toContain("/opt/private-workflow");
    expect(output).toContain("<redacted>");
    expect(output).toContain("<email>");
    expect(output).toContain("<absolute-path>");
  });
});
