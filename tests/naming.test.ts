import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const cwd = process.cwd();
const legacySlug = ["agent", "workflow", "benchmark"].join("-");
const legacyProductName = ["Agent Workflow", "Benchmark"].join(" ");

describe("canonical product naming", () => {
  test("contains no legacy slug or legacy product title in maintained repository surfaces", async () => {
    const files = await fg(
      [
        ".agents/**/*",
        ".claude-plugin/**/*",
        ".gitignore",
        "README*.md",
        "package.json",
        "package-lock.json",
        "scripts/**/*",
        "docs/**/*",
        "plugins/**/*",
        "src/**/*",
        "tests/**/*",
        "schemas/**/*",
        "configs/**/*",
        "fixtures/**/*"
      ],
      {
        cwd,
        dot: true,
        onlyFiles: true,
        ignore: ["**/node_modules/**"]
      }
    );
    const offenders: string[] = [];

    for (const file of files) {
      if (file.includes(legacySlug)) {
        offenders.push(`${file} uses the legacy slug in its path`);
      }
      const content = await readFile(path.join(cwd, file), "utf8");
      if (content.includes(legacySlug)) {
        offenders.push(`${file} contains the legacy slug`);
      }
      if (content.includes(legacyProductName)) {
        offenders.push(`${file} contains the legacy product title`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("keeps the three READMEs concise, aligned, and current with signed workflow-trace admission", async () => {
    const readmes = [
      {
        file: "README.md",
        sections: [
          "# Agent Workflow Bench",
          "## What AWB Does",
          "## Install",
          "## Quick Start",
          "## CI Gate and Trust Boundary",
          "## Common Workflows",
          "## Commands and Artifacts",
          "## Security and Privacy",
          "## Development",
          "## Documentation",
          "## License"
        ]
      },
      {
        file: "README.zh-CN.md",
        sections: [
          "# Agent Workflow Bench",
          "## AWB 能做什么",
          "## 安装",
          "## 快速开始",
          "## CI Gate 与信任边界",
          "## 常用工作流",
          "## 命令与制品",
          "## 安全与隐私",
          "## 开发",
          "## 文档",
          "## 许可证"
        ]
      },
      {
        file: "README.ja.md",
        sections: [
          "# Agent Workflow Bench",
          "## AWB の役割",
          "## インストール",
          "## クイックスタート",
          "## CI Gate と信頼境界",
          "## よく使うワークフロー",
          "## コマンドと成果物",
          "## セキュリティとプライバシー",
          "## 開発",
          "## ドキュメント",
          "## ライセンス"
        ]
      }
    ];

    for (const { file, sections } of readmes) {
      const content = await readFile(path.join(cwd, file), "utf8");
      const positions = sections.map((section) => content.indexOf(section));

      expect(positions, `${file} must contain every canonical section`).not.toContain(-1);
      expect(positions, `${file} sections must use the shared information order`).toEqual(
        [...positions].sort((left, right) => left - right)
      );
      expect(content.match(/^## /gmu)?.length, `${file} must not add unmatched top-level sections`).toBe(
        sections.length - 1
      );
      expect(content.split("\n").length, `${file} should remain a README, not a full manual`).toBeLessThanOrEqual(400);
      expect(content).toContain("agent-workflow-bench@agent-workflow-bench");
      expect(content).toContain("awb ingest-trace");
      expect(content).toContain("--trusted-observer-key");
      expect(content).toContain("docs/workflow-trace-observer-contract.md");
    }
  });
});
