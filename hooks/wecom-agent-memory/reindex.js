#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STATE_PATH = "/Users/ericesan/.openclaw/hooks/wecom-agent-memory/state.json";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function normalizeState(raw) {
  return raw && typeof raw === "object" ? raw : { version: 2, agents: {} };
}

function runJson(args) {
  const result = spawnSync("openclaw", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `command failed: openclaw ${args.join(" ")}`);
  }
  return JSON.parse(result.stdout);
}

function log(action, payload = {}) {
  try {
    console.info(`[wecom-agent-memory] ${action} ${JSON.stringify(payload)}`);
  } catch {
    console.info(`[wecom-agent-memory] ${action}`);
  }
}

function countsMatch(statusRecord) {
  const status = statusRecord?.status ?? {};
  const scan = statusRecord?.scan ?? {};
  const expectedFiles = Number(scan.totalFiles || 0);
  const indexedFiles = Number(status.files || 0);
  const indexedChunks = Number(status.chunks || 0);
  return indexedFiles === expectedFiles && (expectedFiles === 0 || indexedChunks >= expectedFiles);
}

async function main() {
  const agentId = String(process.argv[2] || "").trim();
  if (!agentId) {
    console.error("agentId is required");
    process.exit(1);
  }

  const state = normalizeState(await readJson(STATE_PATH, { version: 2, agents: {} }));
  const agentState = state.agents?.[agentId];
  if (!agentState) {
    log("index_reconciled", { agentId, status: "missing-agent-state" });
    return;
  }

  agentState.lastIndexAttemptAt = Date.now();
  agentState.lastIndexStatus = "running";
  await writeJson(STATE_PATH, state);

  let lastStatusRecord = null;
  let success = false;
  let error = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      spawnSync("openclaw", ["memory", "index", "--agent", agentId, "--force"], { encoding: "utf8" });
      const result = runJson(["memory", "status", "--agent", agentId, "--json"]);
      lastStatusRecord = Array.isArray(result) ? result[0] : result;
      if (countsMatch(lastStatusRecord)) {
        success = true;
        break;
      }
    } catch (err) {
      error = String(err);
    }
  }

  const refreshedState = normalizeState(await readJson(STATE_PATH, { version: 2, agents: {} }));
  const refreshedAgentState = refreshedState.agents?.[agentId];
  if (!refreshedAgentState) return;
  refreshedAgentState.lastIndexAttemptAt = Date.now();
  refreshedAgentState.lastIndexStatus = success ? "indexed" : "pending";
  refreshedAgentState.lastIndexSummary = {
    updatedAt: new Date().toISOString(),
    success,
    error,
    files: lastStatusRecord?.status?.files ?? null,
    chunks: lastStatusRecord?.status?.chunks ?? null,
    scannedFiles: lastStatusRecord?.scan?.totalFiles ?? null,
  };
  if (success) {
    refreshedAgentState.lastIndexedVersion = Math.max(Number(refreshedAgentState.lastIndexedVersion || 0), Number(refreshedAgentState.pendingIndexVersion || 0));
    refreshedAgentState.pendingIndexVersion = 0;
  }
  await writeJson(STATE_PATH, refreshedState);
  log("index_reconciled", {
    agentId,
    success,
    files: lastStatusRecord?.status?.files ?? null,
    chunks: lastStatusRecord?.status?.chunks ?? null,
    scannedFiles: lastStatusRecord?.scan?.totalFiles ?? null,
    error,
  });
}

main().catch((err) => {
  console.error(`[wecom-agent-memory] index_reconciled ${String(err)}`);
  process.exit(1);
});
