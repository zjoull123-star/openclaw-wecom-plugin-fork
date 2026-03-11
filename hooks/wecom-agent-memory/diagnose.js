#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONFIG_PATH = "/Users/ericesan/.openclaw/openclaw.json";
const STATE_PATH = "/Users/ericesan/.openclaw/hooks/wecom-agent-memory/state.json";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function expandHome(value) {
  return typeof value === "string" && value.startsWith("~/") ? value.replace(/^~\//, `${process.env.HOME}/`) : value;
}

function runJson(args) {
  const result = spawnSync("openclaw", args, { encoding: "utf8" });
  if (result.status !== 0) {
    return { error: result.stderr || result.stdout || `command failed: openclaw ${args.join(" ")}` };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: "invalid json", raw: result.stdout };
  }
}

async function main() {
  const agentId = String(process.argv[2] || "").trim();
  if (!agentId) {
    console.error("usage: node diagnose.js <agentId>");
    process.exit(1);
  }

  const cfg = await readJson(CONFIG_PATH, {});
  const state = await readJson(STATE_PATH, { agents: {} });
  const agent = Array.isArray(cfg?.agents?.list) ? cfg.agents.list.find((entry) => String(entry?.id || "") === agentId) : null;
  const sessionsPath = agent?.agentDir ? path.join(path.dirname(expandHome(agent.agentDir)), "sessions", "sessions.json") : null;
  const sessionStore = sessionsPath ? await readJson(sessionsPath, {}) : {};
  const memoryDir = agent?.workspace ? path.join(expandHome(agent.workspace), "memory") : null;
  const memoryStatus = runJson(["memory", "status", "--agent", agentId, "--json"]);
  const output = {
    agentId,
    workspace: agent?.workspace || null,
    agentDir: agent?.agentDir || null,
    memoryDir,
    wecomMemoryConfig: cfg?.channels?.wecom?.memory || null,
    state: state?.agents?.[agentId] || null,
    sessionKeys: Object.keys(sessionStore || {}),
    sessionStore,
    memoryStatus,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
