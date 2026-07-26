#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const args = parseArgs(process.argv.slice(2));
const scanRoot = args.root ? path.resolve(args.root) : defaultRepoRoot;
const outPath = args.out ? path.resolve(args.out) : "";

const categories = [
  {
    id: "absolute_local_path",
    pattern: new RegExp(
      String.raw`(?:^|[^A-Za-z0-9_])(?:/Users|/home)/[A-Za-z0-9_.-]+(?:/|$)`,
      "u"
    )
  },
  {
    id: "private_key_material",
    pattern: new RegExp(String.raw`BEGIN [A-Z ]*PRIVATE KEY`, "u")
  },
  {
    id: "openai_api_token",
    pattern: new RegExp(String.raw`sk-[A-Za-z0-9_-]{20,}`, "u")
  },
  {
    id: "generic_secret_assignment",
    pattern: new RegExp(
      String.raw`\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}`,
      "iu"
    )
  },
  {
    id: "internal_business_data",
    pattern: new RegExp(
      ["internal business", "data"].join(" ") + "|内部业务" + "数据",
      "u"
    )
  }
];

const excludedDirs = new Set([
  ".git",
  ".agents",
  ".omx",
  "node_modules",
  "reports",
  "coverage",
  ".DS_Store"
]);

const files = await listFiles(scanRoot);
const findings = [];

for (const file of files) {
  const relativePath = path.relative(scanRoot, file).split(path.sep).join("/");
  const bytes = await readFile(file);
  if (isLikelyBinary(bytes)) {
    continue;
  }
  const text = bytes.toString("utf8");
  const lineStarts = lineStartOffsets(text);
  for (const category of categories) {
    const match = category.pattern.exec(text);
    if (match?.index !== undefined) {
      findings.push({
        category: category.id,
        location: {
          path: relativePath,
          line: lineForOffset(lineStarts, match.index)
        }
      });
    }
  }
}

findings.sort((left, right) =>
  `${left.category}:${left.location.path}:${left.location.line}`.localeCompare(
    `${right.category}:${right.location.path}:${right.location.line}`
  )
);

const reportWithoutIntegrity = {
  schemaVersion: "0.1.0",
  artifactType: "privacy_scan_report",
  generatedAt: new Date().toISOString(),
  scannedFileCount: files.length,
  findingCount: findings.length,
  findings
};

const report = {
  ...reportWithoutIntegrity,
  integrity: {
    status: "VERIFIED_AT_WRITE",
    contentHash: sha256(JSON.stringify(reportWithoutIntegrity))
  }
};

if (outPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (findings.length > 0) {
  process.stderr.write(
    "Privacy scan found blocked categories at repository-relative locations.\n"
  );
  for (const finding of findings) {
    process.stderr.write(
      `${finding.category} ${finding.location.path}:${finding.location.line}\n`
    );
  }
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (arg === "--root") {
      parsed.root = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unsupported privacy-scan argument: ${arg}`);
    }
  }
  return parsed;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (excludedDirs.has(entry.name)) {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFiles(absolute)));
    } else if (entry.isFile()) {
      output.push(absolute);
    }
  }
  return output;
}

function isLikelyBinary(bytes) {
  const sampleLength = Math.min(bytes.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function lineStartOffsets(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineForOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
