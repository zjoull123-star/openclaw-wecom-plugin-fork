import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = "/Users/ericesan/.openclaw/openclaw.json";
const DEFAULT_REGISTRY_PATH = "~/.openclaw/credentials/wecom-auto-agents.json";
const STATE_PATH = "/Users/ericesan/.openclaw/hooks/wecom-agent-memory/state.json";
const DEFAULT_INDEX_DEBOUNCE_MS = 15000;
const DEFAULT_TAIL_WINDOW_MESSAGES = 12;
const MAX_FACT_LENGTH = 180;
const MAX_SIGNAL_LENGTH = 140;
const CJK_RE = /[\u3400-\u9fff]/u;
const URL_RE = /https?:\/\//i;
const FILE_PATH_RE = /(?:\/Users\/|~\/|[A-Za-z]:\\|\.jsonl\b|\.sqlite\b|\.pdf\b|\.docx\b)/i;
const SECRET_RE = /(token|secret|api[-_ ]?key|approval[- ]?code|pairing code|request id|密码|密钥|口令)/iu;
const TRANSIENT_RE = /(approval[- ]pending|approval-timeout|gateway id=|command exited with code|traceback|collecting\s+|saved to all target workspaces|^NO_(?:REPLY|RENDERER)$)/iu;
const DIRECT_STYLE_RE = /(请用中文|用中文|说中文|默认中文|简短|精简|直接一点|直接执行|不要铺垫|少废话|偏好|习惯|以后都|默认用|请始终|记住)/u;
const STABLE_PROJECT_RE = /(项目|任务|需求|流程|规范|规则|约定|默认|以后|长期|持续|路线|路由|workspace|agent|session|memory|企业微信|wecom|审批|自动放行|广播|群发|负责人|owner|里程碑|群里|本群)/iu;
const STABLE_ROLE_RE = /(管理员|admin|负责人|owner|对接人|联系人|我叫|叫我|我是|负责)/iu;
const GROUP_DECISION_RE = /(本群|群里|规则|流程|约定|默认|以后|统一|规范|要求|负责人|owner|项目|里程碑|任务|禁止|必须)/iu;

function expandUserPath(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueSorted(items) {
  return Array.from(new Set(Array.from(items || []).map((item) => String(item || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function logHook(event, payload = {}) {
  try {
    console.info(`[wecom-agent-memory] ${event} ${JSON.stringify(payload)}`);
  } catch {
    console.info(`[wecom-agent-memory] ${event}`);
  }
}

function pathExists(targetPath) {
  return Boolean(targetPath) && existsSync(targetPath);
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseAgentId(sessionKey) {
  const match = /^agent:([^:]+):/.exec(String(sessionKey || ""));
  return match?.[1] || null;
}

function findAgentEntry(cfg, agentId) {
  return (cfg?.agents?.list || []).find((agent) => String(agent?.id || "") === String(agentId || ""));
}

function resolveRegistryPath(cfg) {
  return expandUserPath(cfg?.channels?.wecom?.autoProvision?.registryPath || DEFAULT_REGISTRY_PATH);
}

function resolveSessionsDir(agent) {
  const agentDir = expandUserPath(String(agent?.agentDir || ""));
  return path.join(path.dirname(agentDir), "sessions");
}

function resolveMemoryFilePaths(workspaceDir) {
  const memoryDir = path.join(workspaceDir, "memory");
  return {
    memoryDir,
    dailyDir: path.join(memoryDir, "daily"),
    preferences: path.join(memoryDir, "preferences.md"),
    projects: path.join(memoryDir, "projects.md"),
    people: path.join(memoryDir, "people.md"),
  };
}

function resolveWeComMemoryConfig(cfg) {
  const raw = cfg?.channels?.wecom?.memory ?? {};
  return {
    enabled: raw.enabled ?? true,
    tailWindowMessages: Math.max(2, safeNumber(raw.tailWindowMessages, DEFAULT_TAIL_WINDOW_MESSAGES)),
    indexDebounceMs: Math.max(1000, safeNumber(raw.indexDebounceMs, DEFAULT_INDEX_DEBOUNCE_MS)),
    protectMemoryDir: raw.protectMemoryDir ?? true,
    groupMode: String(raw.groupMode || "group-facts-only"),
  };
}

function extractText(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content
      .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("\n");
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return "";
}

function cleanMessageText(raw) {
  let text = String(raw || "");
  text = text.replace(/\[\[reply_to_current\]\]\s*/g, "");
  text = text.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```/g, "");
  text = text.replace(/Sender \(untrusted metadata\):[\s\S]*?```/g, "");
  text = text.replace(/\[Queued messages while agent was busy\][\s\S]*?(?=$|\n\n)/g, "");
  text = text.replace(/System:\s*\[[^\]]+\]\s*/g, "");
  text = text.replace(/Exec finished \(gateway id=[^)]+\)/gi, "");
  text = text.replace(/Request ID:\s*[A-Za-z0-9-]+/g, "");
  text = text.replace(/approval[- ]pending/gi, "");
  text = text.replace(/approval-timeout/gi, "");
  return normalizeLine(text);
}

function shouldIgnoreText(text) {
  if (!text) return true;
  if (TRANSIENT_RE.test(text)) return true;
  if (SECRET_RE.test(text)) return true;
  if (URL_RE.test(text)) return true;
  if (FILE_PATH_RE.test(text)) return true;
  if (/^(?:\{|\[)/.test(text) && /"status"|"results"|"version"/.test(text)) return true;
  return false;
}

function sanitizeFact(text) {
  const normalized = normalizeLine(text);
  if (!normalized) return "";
  if (normalized.length > MAX_FACT_LENGTH) return "";
  if (shouldIgnoreText(normalized)) return "";
  if (/^[0-9A-Fa-f-]{6,}$/.test(normalized)) return "";
  return normalized;
}

function sanitizeSignal(text) {
  const normalized = normalizeLine(text);
  if (!normalized) return "";
  if (normalized.length > MAX_SIGNAL_LENGTH) return "";
  if (shouldIgnoreText(normalized)) return "";
  return normalized;
}

function addFact(bucket, line) {
  const normalized = sanitizeFact(line);
  if (normalized) bucket.add(normalized);
}

async function readBulletFile(filePath) {
  if (!pathExists(filePath)) return new Set();
  const raw = await fs.readFile(filePath, "utf8");
  return new Set(raw.split(/\r?\n/).map((line) => line.startsWith("- ") ? line.slice(2) : "").filter(Boolean));
}

async function readDailyFile(filePath) {
  const sections = {
    decisions: new Set(),
    people: new Set(),
    recentSignals: new Set(),
  };
  if (!pathExists(filePath)) return sections;
  const raw = await fs.readFile(filePath, "utf8");
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line === "## Stable Decisions") {
      current = "decisions";
      continue;
    }
    if (line === "## People") {
      current = "people";
      continue;
    }
    if (line === "## Recent Signals") {
      current = "recentSignals";
      continue;
    }
    if (line.startsWith("## ")) {
      current = "";
      continue;
    }
    if (current && line.startsWith("- ")) {
      sections[current].add(line.slice(2));
    }
  }
  return sections;
}

async function writeBulletFile(filePath, title, bullets) {
  const uniqueBullets = uniqueSorted(bullets);
  if (uniqueBullets.length === 0) return false;
  await ensureDir(path.dirname(filePath));
  const content = ["# " + title, "", ...uniqueBullets.map((line) => "- " + line), ""].join("\n");
  const previous = pathExists(filePath) ? await fs.readFile(filePath, "utf8") : null;
  if (previous === content) return false;
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

async function writeDailyFile(filePath, sections) {
  const decisions = uniqueSorted(sections.decisions);
  const people = uniqueSorted(sections.people);
  const recentSignals = uniqueSorted(sections.recentSignals);
  if (decisions.length === 0 && people.length === 0 && recentSignals.length === 0) return false;
  await ensureDir(path.dirname(filePath));
  const content = [
    "# " + path.basename(filePath, ".md"),
    "",
    "## Stable Decisions",
    ...decisions.map((line) => "- " + line),
    "",
    "## People",
    ...people.map((line) => "- " + line),
    "",
    "## Recent Signals",
    ...recentSignals.map((line) => "- " + line),
    "",
  ].join("\n");
  const previous = pathExists(filePath) ? await fs.readFile(filePath, "utf8") : null;
  if (previous === content) return false;
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

function isWeComSessionEntry(entry) {
  return entry?.deliveryContext?.channel === "wecom" || entry?.lastChannel === "wecom" || entry?.origin?.provider === "wecom" || entry?.channel === "wecom";
}

function resolveRegistryEntryByAgentId(registry, agentId) {
  for (const [peerId, entry] of Object.entries(registry?.dm || {})) {
    if (String(entry?.agentId || "") === String(agentId || "")) {
      return { kind: "direct", peerId, entry };
    }
  }
  for (const [peerId, entry] of Object.entries(registry?.group || {})) {
    if (String(entry?.agentId || "") === String(agentId || "")) {
      return { kind: "group", peerId, entry };
    }
  }
  return null;
}

function resolveMainBinding(cfg, agentId, sessionEntry) {
  const bindings = cfg?.bindings || [];
  const deliveryTo = String(sessionEntry?.deliveryContext?.to || sessionEntry?.lastTo || "");
  const peerIdFromTo = deliveryTo.startsWith("wecom:") ? deliveryTo.slice("wecom:".length) : "";
  for (const binding of bindings) {
    if (binding?.match?.channel !== "wecom") continue;
    if (String(binding?.agentId || "") !== String(agentId || "")) continue;
    if (binding?.match?.peer?.kind !== "direct") continue;
    const candidatePeerId = String(binding?.match?.peer?.id || "");
    if (peerIdFromTo && candidatePeerId === peerIdFromTo) {
      return { kind: "direct", peerId: candidatePeerId };
    }
  }
  return null;
}

async function fingerprintFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

async function resolveWeComMemoryTarget(event) {
  if (!event?.sessionKey) return null;
  const cfg = await readJson(CONFIG_PATH, {});
  const memoryConfig = resolveWeComMemoryConfig(cfg);
  if (!memoryConfig.enabled) return null;
  const agentId = parseAgentId(event.sessionKey);
  if (!agentId) return null;
  const agent = findAgentEntry(cfg, agentId);
  if (!agent) return null;
  const sessionsDir = resolveSessionsDir(agent);
  const sessionStorePath = path.join(sessionsDir, "sessions.json");
  const sessionStore = await readJson(sessionStorePath, {});
  const sessionEntry = sessionStore?.[event.sessionKey];
  if (!sessionEntry || !isWeComSessionEntry(sessionEntry)) return null;
  const registry = await readJson(resolveRegistryPath(cfg), { version: 1, dm: {}, group: {} });
  const registryMatch = resolveRegistryEntryByAgentId(registry, agentId);
  const mainMatch = registryMatch ? null : resolveMainBinding(cfg, agentId, sessionEntry);
  const targetMatch = registryMatch || mainMatch;
  if (!targetMatch) return null;
  const workspaceDir = expandUserPath(String(agent.workspace || ""));
  if (!workspaceDir) return null;
  const sessionFile = expandUserPath(String(sessionEntry?.sessionFile || ""));
  if (!pathExists(sessionFile)) return null;
  const sessionId = String(sessionEntry?.sessionId || path.basename(sessionFile, ".jsonl") || "");
  const transcriptFingerprint = await fingerprintFile(sessionFile);
  const target = {
    cfg,
    memoryConfig,
    agentId,
    agent,
    peerKind: targetMatch.kind,
    peerId: targetMatch.peerId,
    workspaceDir,
    sessionKey: event.sessionKey,
    sessionFile,
    sessionId,
    sessionEntry,
    transcriptFingerprint,
    memoryFiles: resolveMemoryFilePaths(workspaceDir),
  };
  logHook("target_resolved", {
    agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    peerKind: target.peerKind,
    peerId: target.peerId,
  });
  return target;
}

async function parseTranscriptMessages(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const out = [];
  let index = 0;
  for (const line of String(raw || "").split(/\r?\n/).filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "message" || !entry.message) continue;
      const role = String(entry.message.role || "");
      if (role !== "user" && role !== "assistant") continue;
      const text = cleanMessageText(extractText(entry.message));
      if (!text || shouldIgnoreText(text)) continue;
      const stableKey = `${entry.id || entry.timestamp || index}:${role}:${hashText(text).slice(0, 12)}`;
      out.push({
        key: stableKey,
        role,
        text,
        timestamp: String(entry.timestamp || entry.message.timestamp || ""),
      });
      index += 1;
    } catch {
      continue;
    }
  }
  return out;
}

function tailMessages(messages, count) {
  if (count <= 0) return [];
  if (messages.length <= count) return messages;
  return messages.slice(messages.length - count);
}

function defaultAgentState() {
  return {
    lastIndexRequestedAt: 0,
    lastIndexAttemptAt: 0,
    lastIndexedVersion: 0,
    pendingIndexVersion: 0,
    lastIndexStatus: "idle",
    writeVersion: 0,
    sessions: {},
  };
}

function defaultSessionState() {
  return {
    sessionId: null,
    sessionFile: null,
    offset: 0,
    transcriptFingerprint: null,
    lastMessageKey: null,
    lastProcessedAt: 0,
    initializedAt: Date.now(),
  };
}

function normalizeState(state) {
  const normalized = state && typeof state === "object" ? state : {};
  const agents = normalized.agents && typeof normalized.agents === "object" ? normalized.agents : {};
  const nextAgents = {};
  for (const [agentId, agentStateRaw] of Object.entries(agents)) {
    const agentState = { ...defaultAgentState(), ...(agentStateRaw && typeof agentStateRaw === "object" ? agentStateRaw : {}) };
    const sessions = agentState.sessions && typeof agentState.sessions === "object" ? agentState.sessions : {};
    const nextSessions = {};
    for (const [sessionKey, sessionStateRaw] of Object.entries(sessions)) {
      nextSessions[sessionKey] = { ...defaultSessionState(), ...(sessionStateRaw && typeof sessionStateRaw === "object" ? sessionStateRaw : {}) };
    }
    agentState.sessions = nextSessions;
    nextAgents[agentId] = agentState;
  }
  return {
    version: 2,
    agents: nextAgents,
  };
}

async function loadState() {
  const raw = await readJson(STATE_PATH, { version: 2, agents: {} });
  return normalizeState(raw);
}

async function saveState(state) {
  await ensureDir(path.dirname(STATE_PATH));
  await fs.writeFile(STATE_PATH, JSON.stringify(normalizeState(state), null, 2) + "\n", "utf8");
}

function diffMessagesAfterCheckpoint(messages, checkpoint, tailWindowMessages) {
  if (!checkpoint) {
    return {
      messages: tailMessages(messages, tailWindowMessages),
      mode: "new-session-tail",
    };
  }
  if (!checkpoint.lastMessageKey) {
    return {
      messages: [],
      mode: "migrated-baseline",
    };
  }
  const lastIndex = messages.findIndex((message) => message.key === checkpoint.lastMessageKey);
  if (lastIndex >= 0) {
    return {
      messages: messages.slice(lastIndex + 1),
      mode: "incremental",
    };
  }
  return {
    messages: tailMessages(messages, tailWindowMessages),
    mode: "tail-reconcile",
  };
}

async function loadIncrementalMessages(target, state) {
  const agentState = state.agents[target.agentId] || defaultAgentState();
  const priorCheckpoint = agentState.sessions[target.sessionKey] || null;
  const messages = await parseTranscriptMessages(target.sessionFile);
  const fileStat = await fs.stat(target.sessionFile);
  const rollover = Boolean(priorCheckpoint) && (
    String(priorCheckpoint.sessionId || "") !== String(target.sessionId || "") ||
    String(priorCheckpoint.sessionFile || "") !== String(target.sessionFile || "")
  );
  if (rollover) {
    logHook("session_rollover_detected", {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      previousSessionId: priorCheckpoint?.sessionId || null,
      sessionId: target.sessionId,
      previousSessionFile: priorCheckpoint?.sessionFile || null,
      sessionFile: target.sessionFile,
    });
  }

  let diff;
  if (!priorCheckpoint) {
    diff = {
      messages: tailMessages(messages, target.memoryConfig.tailWindowMessages),
      mode: "new-session-tail",
    };
  } else if (!priorCheckpoint.lastMessageKey && !rollover && String(priorCheckpoint.sessionFile || "") === String(target.sessionFile || "") && safeNumber(priorCheckpoint.offset, 0) > 0) {
    diff = { messages: [], mode: "migrated-baseline" };
  } else if (rollover) {
    diff = {
      messages: tailMessages(messages, target.memoryConfig.tailWindowMessages),
      mode: "rollover-tail",
    };
  } else {
    diff = diffMessagesAfterCheckpoint(messages, priorCheckpoint, target.memoryConfig.tailWindowMessages);
  }

  const lastMessageKey = messages.at(-1)?.key || null;
  agentState.sessions[target.sessionKey] = {
    ...defaultSessionState(),
    ...(priorCheckpoint || {}),
    sessionId: target.sessionId,
    sessionFile: target.sessionFile,
    offset: fileStat.size,
    transcriptFingerprint: target.transcriptFingerprint,
    lastMessageKey,
    lastProcessedAt: Date.now(),
    initializedAt: priorCheckpoint?.initializedAt || Date.now(),
  };
  state.agents[target.agentId] = agentState;
  logHook("messages_ingested", {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    mode: diff.mode,
    messages: diff.messages.length,
  });
  return diff.messages;
}

function collectConfigFacts(target, facts) {
  const peerLabel = target.peerKind === "group" ? "群" : "私聊";
  if (target.agentId === "main" && target.peerKind === "direct" && target.peerId === "LiaoLiang") {
    addFact(facts.projects, "LiaoLiang 的企业微信私聊固定路由到 main agent，并复用主 workspace。");
    const autoAllow = target.cfg?.tools?.elevated?.autoAllowFrom?.wecom;
    if (Array.isArray(autoAllow) && autoAllow.map(String).includes("LiaoLiang")) {
      addFact(facts.projects, "LiaoLiang 在 main 会话执行宿主机命令默认自动放行，不再进入审批等待。");
    }
    const ownerAllow = Array.isArray(target.cfg?.commands?.ownerAllowFrom) ? target.cfg.commands.ownerAllowFrom.map(String) : [];
    if (ownerAllow.includes("wecom:LiaoLiang")) {
      addFact(facts.people, "LiaoLiang：企业微信侧的 OpenClaw 管理员，通过 main 会话维护配置和高风险命令。");
    }
    return;
  }
  if (target.peerKind === "group") {
    addFact(facts.projects, "该企业微信群使用独立 group agent 和 workspace 处理长期任务。");
  } else {
    addFact(facts.projects, `该企业微信${peerLabel}使用独立 agent 和 workspace 管理长期记忆。`);
  }
}

function collectMessageFacts(target, facts, messages) {
  let userCount = 0;
  let chineseUserCount = 0;
  let directStyleCount = 0;
  for (const message of messages) {
    const text = sanitizeFact(message.text);
    if (!text) continue;
    if (message.role === "user") {
      userCount += 1;
      if (CJK_RE.test(text)) chineseUserCount += 1;
      if (DIRECT_STYLE_RE.test(text)) directStyleCount += 1;
    }
    if (/企业微信普通用户使用指南|wecom user guide/i.test(text)) {
      addFact(facts.projects, "维护企业微信普通用户使用指南，并支持向已接入联系人广播。");
    }
    if (/审批.*ABC|只选择ABC|请直接回复一个字母|A = 允许一次|B = 始终允许|C = 拒绝/i.test(text)) {
      addFact(facts.projects, "企业微信执行审批使用 A/B/C 单字母回复流程。");
    }
    if (/full auto-allow|自动放行|无需审批/i.test(text)) {
      addFact(facts.projects, "当前会话的执行权限策略已调整为无需审批或自动放行。");
    }
    if (/PDF|pdf/.test(text) && /摘要|提取|解析|水印|OCR/i.test(text)) {
      addFact(facts.projects, "持续修复 PDF 解析、摘要、水印和文件回传链路。");
    }
    if (/群发|发给全部|所有人|已接入联系人|广播/i.test(text) && /企业微信|wecom/i.test(text)) {
      addFact(facts.projects, "支持向已接入的企业微信联系人广播公告和指南。");
    }
    if (target.peerKind === "group") {
      if (GROUP_DECISION_RE.test(text)) {
        addFact(facts.projects, text);
      }
      if (STABLE_ROLE_RE.test(text) && !/我叫|叫我|我是/.test(text)) {
        addFact(facts.people, text);
      }
    } else {
      if (DIRECT_STYLE_RE.test(text) && message.role === "user") {
        addFact(facts.preferences, text);
      }
      if (STABLE_PROJECT_RE.test(text)) {
        addFact(facts.projects, text);
      }
      if (STABLE_ROLE_RE.test(text)) {
        addFact(facts.people, text);
      }
    }
    const signal = sanitizeSignal(text);
    if (signal && (GROUP_DECISION_RE.test(text) || DIRECT_STYLE_RE.test(text) || STABLE_PROJECT_RE.test(text) || STABLE_ROLE_RE.test(text))) {
      facts.recentSignals.add(signal);
    }
  }
  if (target.peerKind === "direct" && userCount > 0 && chineseUserCount / userCount >= 0.6) {
    addFact(facts.preferences, "默认使用中文沟通和输出。");
  }
  if (target.peerKind === "direct" && userCount > 0 && directStyleCount / userCount >= 0.4) {
    addFact(facts.preferences, "偏好直接执行并给出简短结论，避免冗长铺垫。");
  }
}

async function loadMergedFacts(target) {
  return {
    preferences: await readBulletFile(target.memoryFiles.preferences),
    projects: await readBulletFile(target.memoryFiles.projects),
    people: await readBulletFile(target.memoryFiles.people),
    recentSignals: new Set(),
  };
}

async function persistFacts(target, facts) {
  const today = new Date().toISOString().slice(0, 10) + ".md";
  const dailyPath = path.join(target.memoryFiles.dailyDir, today);
  const existingDaily = await readDailyFile(dailyPath);
  const mergedDaily = {
    decisions: new Set([...existingDaily.decisions, ...facts.projects]),
    people: new Set([...existingDaily.people, ...facts.people]),
    recentSignals: new Set([...existingDaily.recentSignals, ...facts.recentSignals]),
  };
  const writes = [];
  writes.push(await writeBulletFile(target.memoryFiles.preferences, "Preferences", facts.preferences));
  writes.push(await writeBulletFile(target.memoryFiles.projects, "Projects", facts.projects));
  writes.push(await writeBulletFile(target.memoryFiles.people, "People", facts.people));
  writes.push(await writeDailyFile(dailyPath, mergedDaily));
  return writes.filter(Boolean).length;
}

async function queueReindex(state, target, writeCount) {
  const agentState = state.agents[target.agentId] || defaultAgentState();
  const now = Date.now();
  agentState.writeVersion = safeNumber(agentState.writeVersion, 0) + Math.max(1, writeCount);
  agentState.pendingIndexVersion = agentState.writeVersion;
  const debounceMs = target.memoryConfig.indexDebounceMs;
  if (typeof agentState.lastIndexRequestedAt === "number" && now - agentState.lastIndexRequestedAt < debounceMs) {
    agentState.lastIndexStatus = "pending";
    state.agents[target.agentId] = agentState;
    await saveState(state);
    logHook("index_queued", {
      agentId: target.agentId,
      writeVersion: agentState.writeVersion,
      status: agentState.lastIndexStatus,
      debounced: true,
    });
    return false;
  }
  agentState.lastIndexRequestedAt = now;
  agentState.lastIndexStatus = "queued";
  state.agents[target.agentId] = agentState;
  await saveState(state);
  const child = spawn(process.execPath, [path.join(__dirname, "reindex.js"), target.agentId], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  logHook("index_queued", {
    agentId: target.agentId,
    writeVersion: agentState.writeVersion,
    status: agentState.lastIndexStatus,
    debounced: false,
  });
  return true;
}

export default async function wecomAgentMemoryHook(event) {
  const target = await resolveWeComMemoryTarget(event);
  if (!target) return;
  const state = await loadState();
  const messages = await loadIncrementalMessages(target, state);
  await saveState(state);
  if (messages.length === 0) return;
  const facts = await loadMergedFacts(target);
  const beforeCounts = {
    preferences: facts.preferences.size,
    projects: facts.projects.size,
    people: facts.people.size,
  };
  collectConfigFacts(target, facts);
  collectMessageFacts(target, facts, messages);
  const changedFacts =
    facts.preferences.size > beforeCounts.preferences ||
    facts.projects.size > beforeCounts.projects ||
    facts.people.size > beforeCounts.people ||
    facts.recentSignals.size > 0;
  if (!changedFacts) return;
  const writeCount = await persistFacts(target, facts);
  if (writeCount === 0) return;
  logHook("memory_written", {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    filesChanged: writeCount,
    preferenceFacts: facts.preferences.size,
    projectFacts: facts.projects.size,
    peopleFacts: facts.people.size,
    recentSignals: facts.recentSignals.size,
  });
  await queueReindex(state, target, writeCount);
}
