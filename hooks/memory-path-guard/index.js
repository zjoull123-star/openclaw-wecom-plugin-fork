import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = "/Users/ericesan/.openclaw/openclaw.json";
const BLOCK_REASON = "Long-term memory is system-managed. Do not write or edit files under memory/. Use notes/ for temporary notes.";
const PROTECTED_TOOL_NAMES = new Set(["write", "edit", "exec", "apply_patch"]);

function expandUserPath(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizePath(value, workspaceDir = null) {
  if (typeof value !== "string" || !value.trim()) return null;
  const expanded = expandUserPath(value.trim());
  if (workspaceDir && !path.isAbsolute(expanded)) {
    return path.normalize(path.join(workspaceDir, expanded));
  }
  return path.normalize(expanded);
}

function isWithin(targetPath, protectedDir, workspaceDir = null) {
  const normalizedTarget = normalizePath(targetPath, workspaceDir);
  const normalizedProtected = normalizePath(protectedDir);
  if (!normalizedTarget || !normalizedProtected) return false;
  return normalizedTarget === normalizedProtected || normalizedTarget.startsWith(`${normalizedProtected}${path.sep}`);
}

function resolveWorkspaceDir(cfg, agentId) {
  const agent = Array.isArray(cfg?.agents?.list)
    ? cfg.agents.list.find((entry) => String(entry?.id || "") === String(agentId || ""))
    : null;
  return normalizePath(agent?.workspace || "");
}

function collectCandidatePaths(toolName, params, workspaceDir) {
  const protectedRel = path.join(workspaceDir, "memory");
  const candidates = [];
  if (toolName === "write" || toolName === "edit") {
    for (const key of ["file_path", "path", "filePath"]) {
      if (typeof params?.[key] === "string") candidates.push(normalizePath(params[key], workspaceDir));
    }
  }
  if (toolName === "apply_patch" && typeof params?.patch === "string") {
    const matches = params.patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)|\*\*\* Move to: (.+)/g);
    for (const match of matches) {
      const candidate = match[1] || match[2];
      if (candidate) candidates.push(normalizePath(candidate, workspaceDir));
    }
  }
  if (toolName === "exec") {
    const workdir = normalizePath(params?.workdir || workspaceDir) || workspaceDir;
    const command = String(params?.command || params?.cmd || "");
    if (typeof params?.workdir === "string" && isWithin(workdir, protectedRel, workspaceDir)) {
      candidates.push(workdir);
    }
    if (command.includes(protectedRel)) {
      candidates.push(protectedRel);
    }
    if (workdir && isWithin(workdir, workspaceDir) && /(^|[^A-Za-z0-9_])memory(?:\/|\\|\b)/.test(command)) {
      candidates.push(path.join(workdir, "memory"));
    }
  }
  return candidates;
}

export default async function memoryPathGuard(event, ctx) {
  const toolName = String(event?.toolName || "");
  if (!PROTECTED_TOOL_NAMES.has(toolName)) return;
  const cfg = await readJson(CONFIG_PATH, {});
  const protectMemoryDir = cfg?.channels?.wecom?.memory?.protectMemoryDir ?? true;
  if (!protectMemoryDir) return;
  const workspaceDir = resolveWorkspaceDir(cfg, event?.agentId || ctx?.agentId);
  if (!workspaceDir) return;
  const protectedDir = path.join(workspaceDir, "memory");
  const candidates = collectCandidatePaths(toolName, event?.params || {}, workspaceDir);
  if (candidates.some((candidate) => isWithin(candidate, protectedDir, workspaceDir))) {
    return {
      block: true,
      blockReason: BLOCK_REASON,
    };
  }
}
