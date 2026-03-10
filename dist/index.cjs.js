'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var pluginSdk = require('openclaw/plugin-sdk');
const { readJsonFileWithFallback, withFileLock, writeJsonFileAtomically, DEFAULT_ACCOUNT_ID, addWildcardAllowFrom, formatPairingApproveHint, emptyPluginConfigSchema } = pluginSdk;
var aibotNodeSdk = require('@wecom/aibot-node-sdk');
const { generateReqId, WSClient } = aibotNodeSdk;
var fileType = require('file-type');
const { fileTypeFromBuffer } = fileType;
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var crypto = require('node:crypto');

let runtime = null;
function setWeComRuntime(r) {
    runtime = r;
}
function getWeComRuntime() {
    if (!runtime) {
        throw new Error("WeCom runtime not initialized - plugin not registered");
    }
    return runtime;
}

/**
 * 企业微信渠道常量定义
 */
/**
 * 企业微信渠道 ID
 */
const CHANNEL_ID = "wecom";
/**
 * 企业微信 WebSocket 命令枚举
 */
var WeComCommand;
(function (WeComCommand) {
    /** 认证订阅 */
    WeComCommand["SUBSCRIBE"] = "aibot_subscribe";
    /** 心跳 */
    WeComCommand["PING"] = "ping";
    /** 企业微信推送消息 */
    WeComCommand["AIBOT_CALLBACK"] = "aibot_callback";
    /** clawdbot 响应消息 */
    WeComCommand["AIBOT_RESPONSE"] = "aibot_response";
})(WeComCommand || (WeComCommand = {}));
// ============================================================================
// 超时和重试配置
// ============================================================================
/** 图片下载超时时间（毫秒） */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
/** 文件下载超时时间（毫秒） */
const FILE_DOWNLOAD_TIMEOUT_MS = 60000;
/** 消息发送超时时间（毫秒） */
const REPLY_SEND_TIMEOUT_MS = 15000;
/** 消息处理总超时时间（毫秒） */
const MESSAGE_PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
/** WebSocket 心跳间隔（毫秒） */
const WS_HEARTBEAT_INTERVAL_MS = 30000;
/** WebSocket 最大重连次数 */
const WS_MAX_RECONNECT_ATTEMPTS = 100;
// ============================================================================
// 消息状态管理配置
// ============================================================================
/** messageStates Map 条目的最大 TTL（毫秒），防止内存泄漏 */
const MESSAGE_STATE_TTL_MS = 10 * 60 * 1000;
/** messageStates Map 清理间隔（毫秒） */
const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60000;
/** messageStates Map 最大条目数 */
const MESSAGE_STATE_MAX_SIZE = 500;
// ============================================================================
// 消息模板
// ============================================================================
/** "思考中"流式消息占位内容 */
const THINKING_MESSAGE = "<think></think>";
/** 仅包含图片时的消息占位符 */
const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";
/** 仅包含文件时的消息占位符 */
const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
// ============================================================================
// 默认值
// ============================================================================
/** 默认媒体大小上限（MB） */
const DEFAULT_MEDIA_MAX_MB = 20;
/** 默认媒体保留时长（天） */
const DEFAULT_MEDIA_RETENTION_DAYS = 7;
/** 默认媒体存储子目录 */
const DEFAULT_MEDIA_STORAGE_SUBDIR = CHANNEL_ID;
/** 默认审批处理超时（毫秒） */
const DEFAULT_APPROVAL_RESOLVE_TIMEOUT_MS = 15000;
/** 审批完成回执保留时长（毫秒） */
const DEFAULT_APPROVAL_COMPLETION_TRACK_TTL_MS = 10 * 60 * 1000;
/** 文本分块大小上限 */
const TEXT_CHUNK_LIMIT = 4000;
const AUTO_PROVISION_REGISTRY_VERSION = 1;
const AUTO_PROVISION_BINDING_COMMENT_PREFIX = "wecom:auto:";
const AUTO_PROVISION_DM_KIND = "direct";
const AUTO_PROVISION_GROUP_KIND = "group";
const DEFAULT_AUTO_PROVISION_TEMPLATE_DIR = "~/.openclaw/templates/wecom-default-agent";
const DEFAULT_AUTO_PROVISION_REGISTRY_PATH = "~/.openclaw/credentials/wecom-auto-agents.json";
const DEFAULT_AUTO_PROVISION_DM_WORKSPACE_ROOT = "~/.openclaw/workspace-wecom/dm";
const DEFAULT_AUTO_PROVISION_GROUP_WORKSPACE_ROOT = "~/.openclaw/workspace-wecom/group";
const DEFAULT_GROUP_MENTION_NAME = "openclaw";
const TEMPLATE_SEED_ENTRIES = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "skills"];
const autoProvisionInflight = new Map();
const transcriptReadOffsets = new Map();
const pendingApprovals = new Map();
const resolvedApprovalsAwaitingCompletion = new Map();
const approverPendingApprovalStacks = new Map();
const sessionApprovalGates = new Map();
const APPROVAL_DECISIONS = new Set(["allow-once", "allow-always", "deny"]);
const APPROVAL_SHORTCUT_DECISIONS = new Map([
    ["a", "allow-once"],
    ["b", "allow-always"],
    ["c", "deny"],
]);
const SENSITIVE_KEY_RE = /(secret|token|api[-_]?key|authorization|password)/i;
let approvalTranscriptWatcherStop = null;
function expandUserPath(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
        return raw;
    }
    if (raw === "~") {
        return os.homedir();
    }
    if (raw.startsWith("~/")) {
        return path.join(os.homedir(), raw.slice(2));
    }
    return raw;
}
function normalizeStringEntry(value) {
    const trimmed = String(value ?? "").trim();
    return trimmed ? trimmed : undefined;
}
function isPathInside(parentPath, targetPath) {
    const resolvedParent = path.resolve(parentPath);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedParent || resolvedTarget.startsWith(resolvedParent + path.sep);
}
function sanitizeFileName(value) {
    const normalized = path.basename(String(value ?? "").trim() || "attachment");
    const cleaned = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || "attachment";
}
function truncateForLog(value, maxLength = 240) {
    const text = String(value ?? "");
    return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)) + "…" : text;
}
function sanitizeForLog(value, depth = 0) {
    if (value === null || value === undefined) {
        return value;
    }
    if (depth >= 4) {
        return "[depth-truncated]";
    }
    if (typeof value === "string") {
        return truncateForLog(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 12).map((entry) => sanitizeForLog(entry, depth + 1));
    }
    if (typeof value === "object") {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeForLog(entry, depth + 1);
        }
        return out;
    }
    return String(value);
}
function logWeCom(runtime, message, meta) {
    if (!runtime?.log) {
        return;
    }
    if (meta === undefined) {
        runtime.log(`[WeCom] ${message}`);
        return;
    }
    runtime.log(`[WeCom] ${message}: ${JSON.stringify(sanitizeForLog(meta))}`);
}
function logWeComError(runtime, message, meta) {
    if (!runtime?.error) {
        return;
    }
    if (meta === undefined) {
        runtime.error(`[WeCom] ${message}`);
        return;
    }
    runtime.error(`[WeCom] ${message}: ${JSON.stringify(sanitizeForLog(meta))}`);
}
function resolveMediaRootDir() {
    return path.join(getWeComRuntime().state.resolveStateDir(), "media");
}
function resolveWeComMediaConfig(cfg, runtime) {
    const raw = cfg.channels?.[CHANNEL_ID]?.media ?? {};
    const mediaRoot = resolveMediaRootDir();
    const storageDirRaw = normalizeStringEntry(raw.storageDir) ?? path.join(mediaRoot, DEFAULT_MEDIA_STORAGE_SUBDIR);
    let storageDir = expandUserPath(storageDirRaw);
    if (!path.isAbsolute(storageDir)) {
        storageDir = path.join(mediaRoot, storageDir);
    }
    if (!isPathInside(mediaRoot, storageDir)) {
        logWeCom(runtime, "Media storage dir outside OpenClaw media root; falling back to default", {
            requested: storageDir,
            mediaRoot,
        });
        storageDir = path.join(mediaRoot, DEFAULT_MEDIA_STORAGE_SUBDIR);
    }
    const rawMaxMb = typeof raw.maxMb === "number" && Number.isFinite(raw.maxMb) ? raw.maxMb : undefined;
    const rawRetention = typeof raw.retentionDays === "number" && Number.isFinite(raw.retentionDays) ? raw.retentionDays : undefined;
    return {
        maxMb: rawMaxMb && rawMaxMb > 0 ? rawMaxMb : DEFAULT_MEDIA_MAX_MB,
        retentionDays: rawRetention && rawRetention > 0 ? rawRetention : DEFAULT_MEDIA_RETENTION_DAYS,
        storageDir,
        mediaRoot,
    };
}
function pruneWeComMediaStorage(cfg, runtime) {
    const mediaConfig = resolveWeComMediaConfig(cfg, runtime);
    ensureDir(mediaConfig.storageDir);
    const cutoffMs = Date.now() - mediaConfig.retentionDays * 24 * 60 * 60 * 1000;
    const walk = (targetDir) => {
        if (!pathExists(targetDir)) {
            return;
        }
        for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
            const entryPath = path.join(targetDir, entry.name);
            try {
                if (entry.isDirectory()) {
                    walk(entryPath);
                    if (fs.readdirSync(entryPath).length === 0) {
                        fs.rmdirSync(entryPath);
                    }
                    continue;
                }
                const stat = fs.statSync(entryPath);
                if (stat.mtimeMs < cutoffMs) {
                    fs.rmSync(entryPath, { force: true });
                }
            }
            catch (err) {
                logWeCom(runtime, "Failed to prune media entry", { path: entryPath, error: String(err) });
            }
        }
    };
    walk(mediaConfig.storageDir);
}
function createWeComMediaError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}
function formatSizeMb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function guessExtension(contentType, originalFilename) {
    const knownExt = path.extname(String(originalFilename ?? "").trim());
    if (knownExt) {
        return knownExt.toLowerCase();
    }
    switch (contentType) {
        case "application/pdf":
            return ".pdf";
        case "image/png":
            return ".png";
        case "image/jpeg":
            return ".jpg";
        case "image/webp":
            return ".webp";
        case "image/gif":
            return ".gif";
        default:
            return "";
    }
}
async function saveInboundMediaBuffer(params) {
    const { buffer, contentType, originalFilename, cfg, runtime, kind } = params;
    const mediaConfig = resolveWeComMediaConfig(cfg, runtime);
    ensureDir(mediaConfig.storageDir);
    const maxBytes = mediaConfig.maxMb * 1024 * 1024;
    if (buffer.length > maxBytes) {
        throw createWeComMediaError("too-large", `Media exceeds ${mediaConfig.maxMb}MB limit`, {
            sizeBytes: buffer.length,
            maxBytes,
            originalFilename,
            kind,
        });
    }
    const safeName = sanitizeFileName(originalFilename ?? kind);
    const parsed = path.parse(safeName);
    const ext = guessExtension(contentType, originalFilename);
    const basename = sanitizeFileName(parsed.name || "attachment");
    const fileStem = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${basename}`;
    const filePath = path.join(mediaConfig.storageDir, `${fileStem}${ext || parsed.ext || ""}`);
    const metadataPath = `${filePath}.json`;
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    const metadata = {
        sha256: digest,
        sizeBytes: buffer.length,
        contentType,
        originalFilename: originalFilename ?? null,
        storedAt: new Date().toISOString(),
        kind,
        channel: CHANNEL_ID,
    };
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return {
        path: filePath,
        contentType,
        metadata,
    };
}
function buildFileFailureNotice(originalFilename, error, cfg, runtime) {
    const mediaConfig = resolveWeComMediaConfig(cfg, runtime);
    const name = sanitizeFileName(originalFilename ?? "附件");
    if (error?.code === "too-large") {
        const sizeBytes = Number(error?.details?.sizeBytes ?? 0);
        return `已收到文件“${name}”，但大小为 ${formatSizeMb(sizeBytes)}，超过 ${mediaConfig.maxMb}MB 上限，未处理。`;
    }
    return `已收到文件“${name}”，但读取失败，未处理。`;
}
function resolveWeComApprovalConfig(cfg) {
    const raw = cfg.channels?.[CHANNEL_ID]?.approvals ?? {};
    const fallbackApprovers = resolveOwnerAllowFrom(cfg).map((entry) => normalizeOwnerEntry(entry)).filter(Boolean);
    const notifyTo = Array.isArray(raw.notifyTo)
        ? raw.notifyTo.map((entry) => normalizeOwnerEntry(String(entry))).filter(Boolean)
        : fallbackApprovers;
    return {
        enabled: raw.enabled !== false,
        notifyTo,
        dmOnly: raw.dmOnly !== false,
    };
}
function parseWeComApprovalCommand(text) {
    const trimmed = String(text ?? "").trim();
    const match = trimmed.match(/^\/approve(?:\s+([A-Za-z0-9-]+)(?:\s+(allow-once|allow-always|deny))?)?\s*$/i);
    if (!match) {
        return undefined;
    }
    return {
        id: match[1] ? match[1].trim() : "",
        decision: match[2] ? match[2].toLowerCase() : "",
    };
}
function parseWeComApprovalShortcut(text) {
    const trimmed = String(text ?? "").trim().toLowerCase();
    return APPROVAL_SHORTCUT_DECISIONS.get(trimmed);
}
function rememberPendingApprovalForApprover(approver, approvalId) {
    const key = normalizeOwnerEntry(approver);
    if (!key || !approvalId) {
        return;
    }
    const existing = approverPendingApprovalStacks.get(key) ?? [];
    const next = existing.filter((entry) => entry !== approvalId);
    next.push(approvalId);
    approverPendingApprovalStacks.set(key, next);
}
function removePendingApprovalFromApprovers(approvalId) {
    if (!approvalId) {
        return;
    }
    for (const [approver, stack] of approverPendingApprovalStacks.entries()) {
        const next = stack.filter((entry) => entry !== approvalId);
        if (next.length > 0) {
            approverPendingApprovalStacks.set(approver, next);
        }
        else {
            approverPendingApprovalStacks.delete(approver);
        }
    }
}
function resolveLatestPendingApprovalForApprover(approver) {
    const key = normalizeOwnerEntry(approver);
    if (!key) {
        return undefined;
    }
    const stack = approverPendingApprovalStacks.get(key) ?? [];
    while (stack.length > 0) {
        const approvalId = stack[stack.length - 1];
        const approval = pendingApprovals.get(approvalId);
        if (approval) {
            approverPendingApprovalStacks.set(key, stack);
            return approval;
        }
        stack.pop();
    }
    approverPendingApprovalStacks.delete(key);
    return undefined;
}
function loadSessionStoreEntryForTranscript(sessionFile) {
    const storePath = path.join(path.dirname(sessionFile), "sessions.json");
    if (!pathExists(storePath)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
        for (const [sessionKey, entry] of Object.entries(parsed ?? {})) {
            if (entry && typeof entry === "object" && entry.sessionFile === sessionFile) {
                return {
                    sessionKey,
                    entry,
                    storePath,
                };
            }
        }
    }
    catch (err) {
        logWeCom(runtime, "Failed to read session store for transcript", { sessionFile, error: String(err) });
    }
    return undefined;
}
function readTranscriptEntriesSinceLastOffset(sessionFile) {
    const stat = fs.statSync(sessionFile);
    const existing = transcriptReadOffsets.get(sessionFile) ?? { offset: 0, remainder: "" };
    const startOffset = existing.offset <= stat.size ? existing.offset : 0;
    const bytesToRead = stat.size - startOffset;
    const fd = fs.openSync(sessionFile, "r");
    try {
        const chunk = bytesToRead > 0 ? Buffer.alloc(bytesToRead) : Buffer.alloc(0);
        if (bytesToRead > 0) {
            fs.readSync(fd, chunk, 0, bytesToRead, startOffset);
        }
        const merged = `${startOffset === 0 ? "" : existing.remainder}${chunk.toString("utf8")}`;
        const lines = merged.split(/\r?\n/);
        const remainder = lines.pop() ?? "";
        transcriptReadOffsets.set(sessionFile, { offset: stat.size, remainder });
        return lines.map((line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return undefined;
            }
            try {
                return JSON.parse(trimmed);
            }
            catch {
                return undefined;
            }
        }).filter(Boolean);
    }
    finally {
        fs.closeSync(fd);
    }
}
async function sendApprovalNotificationToApprovers(params) {
    const { approval, cfg, runtime } = params;
    const approvalConfig = resolveWeComApprovalConfig(cfg);
    if (!approvalConfig.enabled || approvalConfig.notifyTo.length === 0) {
        return;
    }
    const commandPreview = truncateForLog(approval.command, 600);
    const requester = approval.deliveryContext?.to ?? approval.sessionKey;
    const content = [
        "执行审批请求",
        `Request ID: ${approval.slug}`,
        `Requester: ${requester}`,
        `Session: ${approval.sessionKey}`,
        approval.cwd ? `CWD: ${approval.cwd}` : undefined,
        `Command: ${commandPreview}`,
        "",
        "请直接回复一个字母：",
        "A = 允许一次",
        "B = 始终允许",
        "C = 拒绝",
    ].filter(Boolean).join("\n");
    for (const approver of approvalConfig.notifyTo) {
        try {
            await sendWeComMessage({
                to: `${CHANNEL_ID}:${approver}`,
                content,
                accountId: approval.accountId,
            });
            rememberPendingApprovalForApprover(approver, approval.id);
        }
        catch (err) {
            logWeComError(runtime, "Failed to send approval notification", {
                approver,
                approvalId: approval.id,
                error: String(err),
            });
        }
    }
}
async function notifyApprovalRequester(approval, content) {
    if (!approval?.deliveryContext?.to) {
        return;
    }
    try {
        await sendWeComMessage({
            to: approval.deliveryContext.to,
            content,
            accountId: approval.accountId,
        });
    }
    catch (err) {
        logWeComError(runtime, "Failed to notify approval requester", {
            approvalId: approval?.id,
            to: approval?.deliveryContext?.to,
            error: String(err),
        });
    }
}
function rememberResolvedApprovalAwaitingCompletion(approval) {
    if (!(approval === null || approval === void 0 ? void 0 : approval.id)) {
        return;
    }
    const existing = resolvedApprovalsAwaitingCompletion.get(approval.id);
    if (existing?.timeoutHandle) {
        clearTimeout(existing.timeoutHandle);
    }
    resolvedApprovalsAwaitingCompletion.set(approval.id, {
        ...approval,
        resolvedAtMs: Date.now(),
        timeoutHandle: setTimeout(() => {
            clearResolvedApprovalAwaitingCompletion(approval.id);
        }, DEFAULT_APPROVAL_COMPLETION_TRACK_TTL_MS),
    });
}
function clearResolvedApprovalAwaitingCompletion(approvalId) {
    const existing = resolvedApprovalsAwaitingCompletion.get(approvalId);
    if (existing?.timeoutHandle) {
        clearTimeout(existing.timeoutHandle);
    }
    resolvedApprovalsAwaitingCompletion.delete(approvalId);
    return existing;
}
async function notifyApprovalCompletion(approval, exitCode) {
    const success = Number(exitCode) === 0;
    const content = success
        ? `执行已完成，原任务继续整理结果。\nRequest ID: ${approval.slug}`
        : `执行已完成（退出码 ${String(exitCode)}），原任务继续根据结果处理。\nRequest ID: ${approval.slug}`;
    await notifyApprovalRequester(approval, content);
}
function getSessionApprovalGate(sessionKey) {
    const key = String(sessionKey ?? "").trim();
    if (!key) {
        return undefined;
    }
    return sessionApprovalGates.get(key);
}
function setSessionApprovalGate(sessionKey, approval) {
    const key = String(sessionKey ?? "").trim();
    if (!key || !(approval === null || approval === void 0 ? void 0 : approval.id)) {
        return;
    }
    sessionApprovalGates.set(key, {
        approvalId: approval.id,
        slug: approval.slug,
        createdAtMs: Date.now(),
    });
}
function clearSessionApprovalGate(sessionKey, approvalId) {
    const key = String(sessionKey ?? "").trim();
    if (!key) {
        return;
    }
    const gate = sessionApprovalGates.get(key);
    if (!gate) {
        return;
    }
    if (!approvalId || gate.approvalId === approvalId) {
        sessionApprovalGates.delete(key);
    }
}
function buildApprovalPendingPlaceholder(gate) {
    return [
        "执行已暂停，等待管理员审批。",
        (gate === null || gate === void 0 ? void 0 : gate.slug) ? `Request ID: ${gate.slug}` : undefined,
    ].filter(Boolean).join("\n");
}
function clearPendingApproval(approvalId) {
    const pending = pendingApprovals.get(approvalId);
    if (pending?.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
    }
    pendingApprovals.delete(approvalId);
    removePendingApprovalFromApprovers(approvalId);
    if (pending?.sessionKey) {
        clearSessionApprovalGate(pending.sessionKey, approvalId);
    }
    return pending;
}
async function handlePendingApprovalExpiry(approvalId) {
    const pending = clearPendingApproval(approvalId);
    if (!pending) {
        return;
    }
    await notifyApprovalRequester(pending, `执行审批已超时，未运行。\nRequest ID: ${pending.slug}`);
}
async function handleApprovalFinishedTranscriptEntry(approvalId, exitCode) {
    const approval = clearResolvedApprovalAwaitingCompletion(approvalId) ?? clearPendingApproval(approvalId);
    if (!approval) {
        return;
    }
    await notifyApprovalCompletion(approval, exitCode);
}
async function handleApprovalTranscriptEntry(transcriptEntry, sessionInfo, cfg, runtime) {
    const message = transcriptEntry?.message;
    const details = message?.details;
    const approvalId = String(details?.approvalId ?? "").trim();
    if (!approvalId || pendingApprovals.has(approvalId)) {
        return;
    }
    const expiresAtMs = Number(details?.expiresAtMs ?? 0);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        return;
    }
    const approval = {
        id: approvalId,
        slug: String(details?.approvalSlug ?? approvalId.slice(0, 8)),
        expiresAtMs,
        command: String(details?.command ?? ""),
        cwd: normalizeStringEntry(details?.cwd),
        sessionKey: sessionInfo.sessionKey,
        deliveryContext: sessionInfo.entry?.deliveryContext,
        accountId: String(sessionInfo.entry?.deliveryContext?.accountId ?? DEFAULT_ACCOUNT_ID),
        timeoutHandle: setTimeout(() => {
            void handlePendingApprovalExpiry(approvalId);
        }, Math.max(0, expiresAtMs - Date.now())),
    };
    pendingApprovals.set(approvalId, approval);
    setSessionApprovalGate(approval.sessionKey, approval);
    await sendApprovalNotificationToApprovers({ approval, cfg, runtime });
}
async function handleTranscriptUpdate(sessionFile) {
    if (!pathExists(sessionFile)) {
        return;
    }
    const cfg = await getWeComRuntime().config.loadConfig();
    const approvalConfig = resolveWeComApprovalConfig(cfg);
    if (!approvalConfig.enabled) {
        return;
    }
    const sessionInfo = loadSessionStoreEntryForTranscript(sessionFile);
    if (!sessionInfo || sessionInfo.entry?.deliveryContext?.channel !== CHANNEL_ID) {
        return;
    }
    const entries = readTranscriptEntriesSinceLastOffset(sessionFile);
    for (const entry of entries) {
        if (entry?.type !== "message") {
            continue;
        }
        const message = entry.message;
        if (message?.role === "toolResult" &&
            message?.toolName === "exec" &&
            message?.details?.status === "approval-pending") {
            await handleApprovalTranscriptEntry(entry, sessionInfo, cfg, runtime);
            continue;
        }
        if (message?.role === "user" && typeof message?.content?.[0]?.text === "string") {
            const text = message.content[0].text;
            const timeoutMatch = text.match(/approval-timeout\):/i);
            const idMatch = text.match(/gateway id=([a-f0-9-]{8,})/i);
            if (timeoutMatch && idMatch) {
                clearPendingApproval(idMatch[1]);
                clearResolvedApprovalAwaitingCompletion(idMatch[1]);
                continue;
            }
            const finishedMatch = text.match(/Exec finished \(gateway id=([a-f0-9-]{8,}), session=[^,]+, code (-?\d+)\)/i);
            if (finishedMatch) {
                await handleApprovalFinishedTranscriptEntry(finishedMatch[1], Number(finishedMatch[2]));
            }
        }
    }
}
function ensureApprovalWatcherStarted() {
    if (approvalTranscriptWatcherStop) {
        return;
    }
    approvalTranscriptWatcherStop = getWeComRuntime().events.onSessionTranscriptUpdate((update) => {
        void handleTranscriptUpdate(update.sessionFile).catch((err) => {
            logWeComError(runtime, "Approval transcript watcher failed", { error: String(err), sessionFile: update.sessionFile });
        });
    });
}
async function primeApprovalWatcher(cfg, runtime) {
    ensureApprovalWatcherStarted();
    const wecomAgentIds = new Set((cfg.bindings ?? [])
        .filter((binding) => binding?.match?.channel === CHANNEL_ID && binding?.agentId)
        .map((binding) => String(binding.agentId)));
    for (const agent of cfg.agents?.list ?? []) {
        const agentId = String(agent?.id ?? "");
        if (!agentId || (!wecomAgentIds.has(agentId) && !agentId.startsWith("wecom-"))) {
            continue;
        }
        const sessionsDir = path.join(expandUserPath(agent.agentDir ?? ""), "..", "sessions");
        const storePath = path.join(sessionsDir, "sessions.json");
        if (!pathExists(storePath)) {
            continue;
        }
        try {
            const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
            for (const entry of Object.values(store ?? {})) {
                const sessionFile = entry?.sessionFile;
                if (typeof sessionFile === "string" && pathExists(sessionFile)) {
                    await handleTranscriptUpdate(sessionFile);
                }
            }
        }
        catch (err) {
            logWeCom(runtime, "Failed to prime approval watcher", { agentId, error: String(err) });
        }
    }
}
async function resolveApprovalViaGateway(approvalId, decision, runtime) {
    const command = [
        "openclaw",
        "gateway",
        "call",
        "exec.approval.resolve",
        "--json",
        "--params",
        JSON.stringify({ id: approvalId, decision }),
    ];
    const result = await getWeComRuntime().system.runCommandWithTimeout(command, {
        timeoutMs: DEFAULT_APPROVAL_RESOLVE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `gateway call failed with code ${String(result.code)}`);
    }
    logWeCom(runtime, "Resolved approval via gateway", { approvalId, decision });
}
function pathExists(targetPath) {
    if (!targetPath) {
        return false;
    }
    return fs.existsSync(targetPath);
}
function ensureDir(targetDir) {
    if (!targetDir) {
        return;
    }
    fs.mkdirSync(targetDir, { recursive: true });
}
function isDirectoryEmpty(targetDir) {
    if (!pathExists(targetDir)) {
        return true;
    }
    return fs.readdirSync(targetDir).length === 0;
}
function copyPathRecursive(sourcePath, destinationPath) {
    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.isDirectory()) {
        ensureDir(destinationPath);
        for (const entry of fs.readdirSync(sourcePath)) {
            copyPathRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
        }
        return;
    }
    ensureDir(path.dirname(destinationPath));
    if (!pathExists(destinationPath)) {
        fs.copyFileSync(sourcePath, destinationPath);
    }
}
function copyTemplateIntoWorkspace(templateDir, workspaceDir) {
    ensureDir(workspaceDir);
    if (!pathExists(templateDir)) {
        return;
    }
    for (const entry of fs.readdirSync(templateDir)) {
        copyPathRecursive(path.join(templateDir, entry), path.join(workspaceDir, entry));
    }
}
function resolveDefaultWorkspacePath(cfg) {
    return normalizeStringEntry(cfg.agents?.defaults?.workspace) ?? "~/.openclaw/workspace";
}
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeMentionName(value) {
    return String(value ?? "").trim().replace(/^@+/, "").replace(/\s+/g, " ");
}
function buildMentionPattern(name) {
    const normalized = normalizeMentionName(name);
    if (!normalized) {
        return undefined;
    }
    return "(?:^|\\s)@?" + escapeRegex(normalized).replace(/\\ /g, "\\s+") + "(?:\\s|$)";
}
function resolveTemplateIdentityNames(templateDir) {
    const identityPath = path.join(templateDir, "IDENTITY.md");
    if (!pathExists(identityPath)) {
        return [];
    }
    try {
        const identityText = fs.readFileSync(identityPath, "utf8");
        const matches = [...identityText.matchAll(/^\s*-\s*Name:[ \t]*([^\r\n]+)\s*$/gim)];
        return matches
            .map((match) => normalizeMentionName(match[1]))
            .filter((name) => Boolean(name) && !/^name:?$/i.test(name) && !name.startsWith("-"));
    }
    catch {
        return [];
    }
}
function buildDefaultMentionPatterns(params) {
    const tokens = new Set();
    for (const name of resolveTemplateIdentityNames(params.templateDir)) {
        tokens.add(name);
    }
    tokens.add(DEFAULT_GROUP_MENTION_NAME);
    if (params.agentId) {
        tokens.add(normalizeMentionName(params.agentId));
    }
    return [...tokens]
        .map((name) => buildMentionPattern(name))
        .filter(Boolean);
}
function ensureTemplateDirSeeded(cfg, templateDir, runtime) {
    if (!isDirectoryEmpty(templateDir)) {
        return;
    }
    ensureDir(templateDir);
    const defaultWorkspaceDir = expandUserPath(resolveDefaultWorkspacePath(cfg));
    for (const entry of TEMPLATE_SEED_ENTRIES) {
        const sourcePath = path.join(defaultWorkspaceDir, entry);
        if (pathExists(sourcePath)) {
            copyPathRecursive(sourcePath, path.join(templateDir, entry));
        }
    }
    ensureDir(path.join(templateDir, "skills"));
    runtime.log?.("[WeCom] Seeded auto-provision template at " + templateDir);
}
function joinConfigPath(rootPath, leaf) {
    const normalizedRoot = String(rootPath ?? "").trim().replace(/\/+$/g, "");
    if (!normalizedRoot) {
        return leaf;
    }
    return normalizedRoot + "/" + leaf;
}
function hash8(value) {
    return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 8);
}
function sanitizeAgentSlug(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .slice(0, 48);
}
function buildProvisionedAgentId(prefix, rawId, takenIds) {
    const normalizedPrefix = sanitizeAgentSlug(prefix) || "wecom";
    const slug = sanitizeAgentSlug(rawId);
    let candidate = slug ? normalizedPrefix + "-" + slug : normalizedPrefix + "-" + hash8(rawId);
    if (candidate.length > 64) {
        candidate = normalizedPrefix + "-" + hash8(rawId);
    }
    if (!takenIds.has(candidate)) {
        return candidate;
    }
    const hashed = normalizedPrefix + "-" + hash8(rawId);
    if (!takenIds.has(hashed)) {
        return hashed;
    }
    let counter = 2;
    while (takenIds.has(hashed + "-" + counter)) {
        counter += 1;
    }
    return hashed + "-" + counter;
}
function createEmptyAutoProvisionRegistry() {
    return {
        version: AUTO_PROVISION_REGISTRY_VERSION,
        dm: {},
        group: {},
    };
}
function kindToRegistrySection(kind) {
    return kind === AUTO_PROVISION_GROUP_KIND ? "group" : "dm";
}
function sanitizeAutoProvisionEntry(entry, kind) {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    const peerId = normalizeStringEntry(entry.peerId);
    const agentId = normalizeStringEntry(entry.agentId);
    const workspace = normalizeStringEntry(entry.workspace);
    const agentDir = normalizeStringEntry(entry.agentDir);
    if (!peerId || !agentId || !workspace || !agentDir) {
        return undefined;
    }
    const normalized = {
        peerId,
        agentId,
        workspace,
        agentDir,
        createdAt: normalizeStringEntry(entry.createdAt) ?? new Date().toISOString(),
        updatedAt: normalizeStringEntry(entry.updatedAt) ?? new Date().toISOString(),
    };
    if (kind === AUTO_PROVISION_GROUP_KIND) {
        normalized.mentionPatterns = Array.isArray(entry.mentionPatterns)
            ? entry.mentionPatterns.map((value) => String(value).trim()).filter(Boolean)
            : [];
    }
    return normalized;
}
function sanitizeAutoProvisionSection(value, kind) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const out = {};
    for (const [peerId, entry] of Object.entries(value)) {
        const normalized = sanitizeAutoProvisionEntry({
            ...(entry ?? {}),
            peerId,
        }, kind);
        if (normalized) {
            out[peerId] = normalized;
        }
    }
    return out;
}
function sanitizeAutoProvisionRegistry(value) {
    const base = createEmptyAutoProvisionRegistry();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return base;
    }
    return {
        version: AUTO_PROVISION_REGISTRY_VERSION,
        dm: sanitizeAutoProvisionSection(value.dm, AUTO_PROVISION_DM_KIND),
        group: sanitizeAutoProvisionSection(value.group, AUTO_PROVISION_GROUP_KIND),
    };
}
async function readAutoProvisionRegistry(registryPath) {
    const { value } = await readJsonFileWithFallback(registryPath, createEmptyAutoProvisionRegistry());
    return sanitizeAutoProvisionRegistry(value);
}
async function writeAutoProvisionRegistry(registryPath, registry) {
    ensureDir(path.dirname(registryPath));
    await writeJsonFileAtomically(registryPath, sanitizeAutoProvisionRegistry(registry));
}
function resolveAutoProvisionConfig(cfg) {
    const raw = cfg.channels?.[CHANNEL_ID]?.autoProvision ?? {};
    const dm = raw.dm ?? {};
    const group = raw.group ?? {};
    const registryPathRaw = normalizeStringEntry(raw.registryPath) ?? DEFAULT_AUTO_PROVISION_REGISTRY_PATH;
    const templateDirRaw = normalizeStringEntry(raw.templateDir) ?? DEFAULT_AUTO_PROVISION_TEMPLATE_DIR;
    const dmWorkspaceRootRaw = normalizeStringEntry(dm.workspaceRoot) ?? DEFAULT_AUTO_PROVISION_DM_WORKSPACE_ROOT;
    const groupWorkspaceRootRaw = normalizeStringEntry(group.workspaceRoot) ?? DEFAULT_AUTO_PROVISION_GROUP_WORKSPACE_ROOT;
    return {
        enabled: raw.enabled === true,
        registryPathRaw,
        registryPath: expandUserPath(registryPathRaw),
        templateDirRaw,
        templateDir: expandUserPath(templateDirRaw),
        dm: {
            agentIdPrefix: normalizeStringEntry(dm.agentIdPrefix) ?? "wecom-dm",
            workspaceRootRaw: dmWorkspaceRootRaw,
            workspaceRoot: expandUserPath(dmWorkspaceRootRaw),
        },
        group: {
            agentIdPrefix: normalizeStringEntry(group.agentIdPrefix) ?? "wecom-group",
            workspaceRootRaw: groupWorkspaceRootRaw,
            workspaceRoot: expandUserPath(groupWorkspaceRootRaw),
            requireMention: group.requireMention !== false,
        },
    };
}
function buildAutoProvisionBindingComment(kind, peerId) {
    return AUTO_PROVISION_BINDING_COMMENT_PREFIX + kind + ":" + peerId;
}
function parseAutoProvisionBindingComment(value) {
    const match = /^wecom:auto:(direct|group):(.+)$/.exec(String(value ?? "").trim());
    if (!match) {
        return undefined;
    }
    return {
        kind: match[1],
        peerId: match[2],
    };
}
function resolveOwnerAllowFrom(cfg) {
    const configured = Array.isArray(cfg.commands?.ownerAllowFrom)
        ? cfg.commands.ownerAllowFrom.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    if (configured.length > 0) {
        return configured;
    }
    const fallback = cfg.tools?.elevated?.allowFrom?.[CHANNEL_ID];
    if (!Array.isArray(fallback)) {
        return [];
    }
    return fallback
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.startsWith(CHANNEL_ID + ":") ? entry : CHANNEL_ID + ":" + entry);
}
function normalizeOwnerEntry(entry) {
    return String(entry ?? "")
        .replace(new RegExp("^" + CHANNEL_ID + ":", "i"), "")
        .replace(/^user:/i, "")
        .trim();
}
function isWeComOwnerSender(senderId, ownerAllowFrom) {
    if (ownerAllowFrom.includes("*")) {
        return true;
    }
    return ownerAllowFrom.some((entry) => {
        const normalized = normalizeOwnerEntry(entry);
        return normalized === senderId;
    });
}
function resolveHighRiskCommandKey(text) {
    const trimmed = String(text ?? "").trim().toLowerCase();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith("!")) {
        return "!";
    }
    if (trimmed.startsWith("/bash")) {
        return "/bash";
    }
    if (trimmed.startsWith("/restart")) {
        return "/restart";
    }
    if (trimmed.startsWith("/approve")) {
        return "/approve";
    }
    if (trimmed.startsWith("/activation")) {
        return "/activation";
    }
    if (trimmed.startsWith("/config set")) {
        return "/config set";
    }
    if (trimmed.startsWith("/config unset")) {
        return "/config unset";
    }
    return undefined;
}
function resolveWeComCommandAccess(params) {
    const ownerAllowFrom = resolveOwnerAllowFrom(params.cfg);
    const senderIsOwner = isWeComOwnerSender(params.senderId, ownerAllowFrom);
    const shouldCompute = getWeComRuntime().channel.commands.shouldComputeCommandAuthorized(params.text ?? "", params.cfg);
    const highRiskKey = resolveHighRiskCommandKey(params.text);
    return {
        ownerAllowFrom,
        senderIsOwner,
        highRiskKey,
        commandAuthorized: shouldCompute ? (highRiskKey ? senderIsOwner : true) : true,
    };
}
function findAgentEntry(cfg, agentId) {
    if (!Array.isArray(cfg.agents?.list)) {
        return undefined;
    }
    return cfg.agents.list.find((entry) => String(entry?.id ?? "") === agentId);
}
function buildMainAgentEntry(cfg) {
    return {
        id: "main",
        default: true,
        name: "main",
        workspace: resolveDefaultWorkspacePath(cfg),
        agentDir: "~/.openclaw/agents/main/agent",
    };
}
function ensureMainAgentConfigured(cfg) {
    const existingAgents = Array.isArray(cfg.agents?.list)
        ? cfg.agents.list.map((entry) => ({ ...entry }))
        : [];
    if (existingAgents.some((entry) => String(entry?.id ?? "") === "main")) {
        return { cfg, changed: false };
    }
    const hasDefaultAgent = existingAgents.some((entry) => entry?.default === true);
    const mainAgent = buildMainAgentEntry(cfg);
    if (hasDefaultAgent) {
        delete mainAgent.default;
    }
    existingAgents.unshift(mainAgent);
    return {
        cfg: {
            ...cfg,
            agents: {
                ...(cfg.agents ?? {}),
                list: existingAgents,
            },
        },
        changed: true,
    };
}
function findWeComBinding(cfg, accountId, kind, peerId) {
    const expectedAccountId = String(accountId ?? DEFAULT_ACCOUNT_ID);
    return (cfg.bindings ?? []).find((binding) => {
        if (binding?.match?.channel !== CHANNEL_ID) {
            return false;
        }
        if (String(binding.match?.accountId ?? DEFAULT_ACCOUNT_ID) !== expectedAccountId) {
            return false;
        }
        return binding.match?.peer?.kind === kind && String(binding.match?.peer?.id ?? "") === peerId;
    });
}
function buildRegistryEntryFromConfig(cfg, accountId, kind, peerId) {
    const binding = findWeComBinding(cfg, accountId, kind, peerId);
    if (!binding) {
        return undefined;
    }
    const agent = findAgentEntry(cfg, String(binding.agentId ?? ""));
    if (!agent) {
        return undefined;
    }
    return sanitizeAutoProvisionEntry({
        peerId,
        agentId: String(agent.id),
        workspace: agent.workspace,
        agentDir: agent.agentDir,
        mentionPatterns: kind === AUTO_PROVISION_GROUP_KIND ? agent.groupChat?.mentionPatterns : undefined,
    }, kind);
}
function ensureProvisionedFilesystem(params) {
    const { cfg, autoProvision, kind, entry, runtime } = params;
    ensureTemplateDirSeeded(cfg, autoProvision.templateDir, runtime);
    ensureDir(expandUserPath(entry.agentDir));
    const workspaceDir = expandUserPath(entry.workspace);
    ensureDir(workspaceDir);
    copyTemplateIntoWorkspace(autoProvision.templateDir, workspaceDir);
    if (kind === AUTO_PROVISION_GROUP_KIND &&
        (!Array.isArray(entry.mentionPatterns) || entry.mentionPatterns.length === 0)) {
        entry.mentionPatterns = buildDefaultMentionPatterns({
            templateDir: autoProvision.templateDir,
            agentId: entry.agentId,
        });
        return true;
    }
    return false;
}
function ensureProvisionedAgentConfig(cfg, params) {
    const { entry, kind, accountId, autoProvision } = params;
    let nextCfg = cfg;
    let changed = false;
    const mainResult = ensureMainAgentConfigured(nextCfg);
    if (mainResult.changed) {
        nextCfg = mainResult.cfg;
        changed = true;
    }
    const agents = Array.isArray(nextCfg.agents?.list)
        ? nextCfg.agents.list.map((agent) => ({
            ...agent,
            groupChat: agent?.groupChat ? { ...agent.groupChat } : agent?.groupChat,
        }))
        : [];
    const desiredName = kind === AUTO_PROVISION_GROUP_KIND
        ? "WeCom Group " + entry.peerId
        : "WeCom DM " + entry.peerId;
    const agentIndex = agents.findIndex((agent) => String(agent?.id ?? "") === entry.agentId);
    const existingAgent = agentIndex >= 0 ? agents[agentIndex] : undefined;
    const nextAgent = {
        ...(existingAgent ?? {}),
        id: entry.agentId,
        name: existingAgent?.name ?? desiredName,
        workspace: existingAgent?.workspace ?? entry.workspace,
        agentDir: existingAgent?.agentDir ?? entry.agentDir,
    };
    if (kind === AUTO_PROVISION_GROUP_KIND) {
        nextAgent.groupChat = {
            ...(existingAgent?.groupChat ?? {}),
            mentionPatterns: Array.isArray(existingAgent?.groupChat?.mentionPatterns) &&
                existingAgent.groupChat.mentionPatterns.length > 0
                ? existingAgent.groupChat.mentionPatterns
                : (entry.mentionPatterns ?? buildDefaultMentionPatterns({
                    templateDir: autoProvision.templateDir,
                    agentId: entry.agentId,
                })),
        };
    }
    if (agentIndex === -1) {
        agents.push(nextAgent);
        changed = true;
    }
    else if (JSON.stringify(existingAgent) !== JSON.stringify(nextAgent)) {
        agents[agentIndex] = nextAgent;
        changed = true;
    }
    if (changed) {
        nextCfg = {
            ...nextCfg,
            agents: {
                ...(nextCfg.agents ?? {}),
                list: agents,
            },
        };
    }
    const desiredBinding = {
        agentId: entry.agentId,
        comment: buildAutoProvisionBindingComment(kind, entry.peerId),
        match: {
            channel: CHANNEL_ID,
            accountId,
            peer: {
                kind,
                id: entry.peerId,
            },
        },
    };
    const bindings = Array.isArray(nextCfg.bindings)
        ? nextCfg.bindings.map((binding) => ({
            ...binding,
            match: binding?.match
                ? {
                    ...binding.match,
                    peer: binding.match.peer ? { ...binding.match.peer } : binding.match.peer,
                }
                : binding?.match,
        }))
        : [];
    const bindingIndex = bindings.findIndex((binding) => {
        const parsedComment = parseAutoProvisionBindingComment(binding?.comment);
        if (binding?.match?.channel === CHANNEL_ID &&
            String(binding.match?.accountId ?? DEFAULT_ACCOUNT_ID) === String(accountId) &&
            binding.match?.peer?.kind === kind &&
            String(binding.match?.peer?.id ?? "") === entry.peerId) {
            return true;
        }
        return parsedComment?.kind === kind && parsedComment?.peerId === entry.peerId;
    });
    if (bindingIndex === -1) {
        bindings.push(desiredBinding);
        changed = true;
    }
    else if (JSON.stringify(bindings[bindingIndex]) !== JSON.stringify(desiredBinding)) {
        bindings[bindingIndex] = desiredBinding;
        changed = true;
    }
    if (changed) {
        nextCfg = {
            ...nextCfg,
            bindings,
        };
    }
    return { cfg: nextCfg, changed };
}
function compileMentionRegexes(patterns) {
    return (patterns ?? [])
        .map((pattern) => String(pattern).trim())
        .filter(Boolean)
        .map((pattern) => {
        try {
            return new RegExp(pattern, "i");
        }
        catch {
            return undefined;
        }
    })
        .filter(Boolean);
}
function resolveGroupMentionRegexes(cfg, accountId, groupId, autoProvision) {
    const binding = findWeComBinding(cfg, accountId, AUTO_PROVISION_GROUP_KIND, groupId);
    if (binding?.agentId) {
        return getWeComRuntime().channel.mentions.buildMentionRegexes(cfg, String(binding.agentId));
    }
    return compileMentionRegexes(buildDefaultMentionPatterns({
        templateDir: autoProvision.templateDir,
    }));
}
function shouldHandleWeComGroupMessage(params) {
    const { text, cfg, accountId, groupId, autoProvision, runtime } = params;
    if (!autoProvision.group.requireMention) {
        return true;
    }
    const mentionRegexes = resolveGroupMentionRegexes(cfg, accountId, groupId, autoProvision);
    const mentioned = getWeComRuntime().channel.mentions.matchesMentionPatterns(text ?? "", mentionRegexes);
    if (!mentioned) {
        runtime.log?.("[WeCom] Ignored unmentioned group message in " + groupId);
    }
    return mentioned;
}
async function withAutoProvisionSingleFlight(key, factory) {
    if (autoProvisionInflight.has(key)) {
        return await autoProvisionInflight.get(key);
    }
    const task = (async () => await factory())().finally(() => {
        autoProvisionInflight.delete(key);
    });
    autoProvisionInflight.set(key, task);
    return await task;
}
async function ensureWeComPeerProvisioned(params) {
    const { cfg, runtime, accountId, kind, peerId } = params;
    const autoProvision = resolveAutoProvisionConfig(cfg);
    if (!autoProvision.enabled) {
        return { cfg, autoProvision };
    }
    const inflightKey = [accountId, kind, peerId].join(":");
    return await withAutoProvisionSingleFlight(inflightKey, async () => {
        ensureDir(path.dirname(autoProvision.registryPath));
        ensureTemplateDirSeeded(cfg, autoProvision.templateDir, runtime);
        return await withFileLock(autoProvision.registryPath, DEFAULT_LOCK_OPTIONS, async () => {
            let nextCfg = cfg;
            const registry = await readAutoProvisionRegistry(autoProvision.registryPath);
            const registrySection = kindToRegistrySection(kind);
            let entry = registry[registrySection][peerId] ?? buildRegistryEntryFromConfig(nextCfg, accountId, kind, peerId);
            let registryChanged = false;
            if (!entry) {
                const takenAgentIds = new Set((nextCfg.agents?.list ?? [])
                    .map((agent) => String(agent?.id ?? ""))
                    .filter(Boolean));
                const mode = kind === AUTO_PROVISION_GROUP_KIND ? autoProvision.group : autoProvision.dm;
                const agentId = buildProvisionedAgentId(mode.agentIdPrefix, peerId, takenAgentIds);
                entry = sanitizeAutoProvisionEntry({
                    peerId,
                    agentId,
                    workspace: joinConfigPath(mode.workspaceRootRaw, agentId),
                    agentDir: "~/.openclaw/agents/" + agentId + "/agent",
                    mentionPatterns: kind === AUTO_PROVISION_GROUP_KIND
                        ? buildDefaultMentionPatterns({
                            templateDir: autoProvision.templateDir,
                            agentId,
                        })
                        : undefined,
                }, kind);
                registry[registrySection][peerId] = entry;
                registryChanged = true;
            }
            const filesystemChanged = ensureProvisionedFilesystem({
                cfg: nextCfg,
                autoProvision,
                kind,
                entry,
                runtime,
            });
            if (filesystemChanged) {
                entry.updatedAt = new Date().toISOString();
                registry[registrySection][peerId] = entry;
                registryChanged = true;
            }
            const reconcileResult = ensureProvisionedAgentConfig(nextCfg, {
                entry,
                kind,
                accountId,
                autoProvision,
            });
            if (reconcileResult.changed) {
                nextCfg = reconcileResult.cfg;
            }
            if (registryChanged) {
                await writeAutoProvisionRegistry(autoProvision.registryPath, registry);
            }
            runtime.log?.("[WeCom] Provisioned " + kind + " peer " + peerId + " -> " + entry.agentId);
            return {
                cfg: nextCfg,
                entry,
                autoProvision,
                configChanged: reconcileResult.changed,
            };
        });
    });
}
async function persistProvisionedConfig(params) {
    const autoProvision = resolveAutoProvisionConfig(params.cfg);
    return await withFileLock(autoProvision.registryPath, DEFAULT_LOCK_OPTIONS, async () => {
        const diskCfg = await getWeComRuntime().config.loadConfig();
        const reconcileResult = ensureProvisionedAgentConfig(diskCfg, {
            entry: params.entry,
            kind: params.kind,
            accountId: params.accountId,
            autoProvision,
        });
        if (reconcileResult.changed) {
            await getWeComRuntime().config.writeConfigFile(reconcileResult.cfg);
        }
        return reconcileResult.cfg;
    });
}
function scanAutoProvisionEntriesFromConfig(cfg, accountId) {
    const out = [];
    for (const binding of cfg.bindings ?? []) {
        const parsedComment = parseAutoProvisionBindingComment(binding?.comment);
        if (!parsedComment) {
            continue;
        }
        if (binding?.match?.channel !== CHANNEL_ID) {
            continue;
        }
        if (String(binding.match?.accountId ?? DEFAULT_ACCOUNT_ID) !== String(accountId ?? DEFAULT_ACCOUNT_ID)) {
            continue;
        }
        const agent = findAgentEntry(cfg, String(binding.agentId ?? ""));
        if (!agent) {
            continue;
        }
        const peerId = String(binding.match?.peer?.id ?? parsedComment.peerId ?? "");
        if (!peerId) {
            continue;
        }
        const kind = binding.match?.peer?.kind === AUTO_PROVISION_GROUP_KIND
            ? AUTO_PROVISION_GROUP_KIND
            : AUTO_PROVISION_DM_KIND;
        const entry = sanitizeAutoProvisionEntry({
            peerId,
            agentId: String(agent.id),
            workspace: agent.workspace,
            agentDir: agent.agentDir,
            mentionPatterns: kind === AUTO_PROVISION_GROUP_KIND ? agent.groupChat?.mentionPatterns : undefined,
        }, kind);
        if (entry) {
            out.push({ kind, entry });
        }
    }
    return out;
}
async function reconcileAutoProvisionedState(params) {
    const autoProvision = resolveAutoProvisionConfig(params.cfg);
    if (!autoProvision.enabled) {
        return params.cfg;
    }
    ensureDir(path.dirname(autoProvision.registryPath));
    ensureTemplateDirSeeded(params.cfg, autoProvision.templateDir, params.runtime);
    return await withFileLock(autoProvision.registryPath, DEFAULT_LOCK_OPTIONS, async () => {
        let nextCfg = params.cfg;
        const registry = await readAutoProvisionRegistry(autoProvision.registryPath);
        let registryChanged = false;
        let configChanged = false;
        for (const discovered of scanAutoProvisionEntriesFromConfig(nextCfg, params.accountId)) {
            const registrySection = kindToRegistrySection(discovered.kind);
            const existing = registry[registrySection][discovered.entry.peerId];
            if (JSON.stringify(existing) !== JSON.stringify(discovered.entry)) {
                registry[registrySection][discovered.entry.peerId] = discovered.entry;
                registryChanged = true;
            }
        }
        for (const kind of [AUTO_PROVISION_DM_KIND, AUTO_PROVISION_GROUP_KIND]) {
            const registrySection = kindToRegistrySection(kind);
            for (const entry of Object.values(registry[registrySection])) {
                const filesystemChanged = ensureProvisionedFilesystem({
                    cfg: nextCfg,
                    autoProvision,
                    kind,
                    entry,
                    runtime: params.runtime,
                });
                if (filesystemChanged) {
                    entry.updatedAt = new Date().toISOString();
                    registry[registrySection][entry.peerId] = entry;
                    registryChanged = true;
                }
                const reconcileResult = ensureProvisionedAgentConfig(nextCfg, {
                    entry,
                    kind,
                    accountId: params.accountId,
                    autoProvision,
                });
                if (reconcileResult.changed) {
                    nextCfg = reconcileResult.cfg;
                    configChanged = true;
                }
            }
        }
        if (configChanged) {
            await getWeComRuntime().config.writeConfigFile(nextCfg);
        }
        if (registryChanged) {
            await writeAutoProvisionRegistry(autoProvision.registryPath, registry);
        }
        return nextCfg;
    });
}

/**
 * 企业微信消息内容解析模块
 *
 * 负责从 WsFrame 中提取文本、图片、引用等内容
 */
// ============================================================================
// 解析函数
// ============================================================================
/**
 * 解析消息内容（支持单条消息、图文混排和引用消息）
 * @returns 提取的文本数组、图片URL数组和引用消息内容
 */
function parseMessageContent(body) {
    const textParts = [];
    const imageUrls = [];
    const imageAesKeys = new Map();
    const fileUrls = [];
    const fileAesKeys = new Map();
    let quoteContent;
    // 处理图文混排消息
    if (body.msgtype === "mixed" && body.mixed?.msg_item) {
        for (const item of body.mixed.msg_item) {
            if (item.msgtype === "text" && item.text?.content) {
                textParts.push(item.text.content);
            }
            else if (item.msgtype === "image" && item.image?.url) {
                imageUrls.push(item.image.url);
                if (item.image.aeskey) {
                    imageAesKeys.set(item.image.url, item.image.aeskey);
                }
            }
        }
    }
    else {
        // 处理单条消息
        if (body.text?.content) {
            textParts.push(body.text.content);
        }
        // 处理语音消息（语音转文字后的文本内容）
        if (body.msgtype === "voice" && body.voice?.content) {
            textParts.push(body.voice.content);
        }
        if (body.image?.url) {
            imageUrls.push(body.image.url);
            if (body.image.aeskey) {
                imageAesKeys.set(body.image.url, body.image.aeskey);
            }
        }
        // 处理文件消息
        if (body.msgtype === "file" && body.file?.url) {
            fileUrls.push(body.file.url);
            if (body.file.aeskey) {
                fileAesKeys.set(body.file.url, body.file.aeskey);
            }
        }
    }
    // 处理引用消息
    if (body.quote) {
        if (body.quote.msgtype === "text" && body.quote.text?.content) {
            quoteContent = body.quote.text.content;
        }
        else if (body.quote.msgtype === "voice" && body.quote.voice?.content) {
            quoteContent = body.quote.voice.content;
        }
        else if (body.quote.msgtype === "image" && body.quote.image?.url) {
            // 引用的图片消息：将图片 URL 加入下载列表
            imageUrls.push(body.quote.image.url);
            if (body.quote.image.aeskey) {
                imageAesKeys.set(body.quote.image.url, body.quote.image.aeskey);
            }
        }
        else if (body.quote.msgtype === "file" && body.quote.file?.url) {
            // 引用的文件消息：将文件 URL 加入下载列表
            fileUrls.push(body.quote.file.url);
            if (body.quote.file.aeskey) {
                fileAesKeys.set(body.quote.file.url, body.quote.file.aeskey);
            }
        }
    }
    return { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent };
}

/**
 * 超时控制工具模块
 *
 * 为异步操作提供统一的超时保护机制
 */
/**
 * 为 Promise 添加超时保护
 *
 * @param promise - 原始 Promise
 * @param timeoutMs - 超时时间（毫秒）
 * @param message - 超时错误消息
 * @returns 带超时保护的 Promise
 */
function withTimeout(promise, timeoutMs, message) {
    if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
        return promise;
    }
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new TimeoutError(message ?? `Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}
/**
 * 超时错误类型
 */
class TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "TimeoutError";
    }
}

/**
 * 企业微信消息发送模块
 *
 * 负责通过 WSClient 发送回复消息，包含超时保护
 */
// ============================================================================
// 消息发送
// ============================================================================
/**
 * 发送企业微信回复消息
 * 供 monitor 内部和 channel outbound 使用
 *
 * @returns messageId (streamId)
 */
async function sendWeComReply(params) {
    const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;
    if (!text) {
        return "";
    }
    const streamId = existingStreamId || generateReqId("stream");
    if (!wsClient.isConnected) {
        runtime.error?.(`[WeCom] WSClient not connected, cannot send reply`);
        throw new Error("WSClient not connected");
    }
    // 使用 SDK 的 replyStream 方法发送消息，带超时保护
    await withTimeout(wsClient.replyStream(frame, streamId, text, finish), REPLY_SEND_TIMEOUT_MS, `Reply send timed out (streamId=${streamId})`);
    runtime.log?.(`[WeCom] Sent reply: streamId=${streamId}, finish=${finish}`);
    return streamId;
}

/**
 * 企业微信媒体（图片）下载和保存模块
 *
 * 负责下载、检测格式、保存图片到本地，包含超时保护
 */
// ============================================================================
// 图片格式检测辅助函数（基于 file-type 包）
// ============================================================================
/**
 * 检查 Buffer 是否为有效的图片格式
 */
async function isImageBuffer(data) {
    const type = await fileTypeFromBuffer(data);
    return type?.mime.startsWith("image/") ?? false;
}
/**
 * 检测 Buffer 的图片内容类型
 */
async function detectImageContentType(data) {
    const type = await fileTypeFromBuffer(data);
    if (type?.mime.startsWith("image/")) {
        return type.mime;
    }
    return "application/octet-stream";
}
// ============================================================================
// 图片下载和保存
// ============================================================================
/**
 * 下载并保存所有图片到本地，每张图片的下载带超时保护
 */
async function downloadAndSaveImages(params) {
    const { imageUrls, config, runtime, wsClient } = params;
    const core = getWeComRuntime();
    const mediaList = [];
    const notices = [];
    for (const imageUrl of imageUrls) {
        try {
            logWeCom(runtime, "Downloading image", { imageUrl });
            let imageBuffer;
            let imageContentType;
            let originalFilename;
            const imageAesKey = params.imageAesKeys?.get(imageUrl);
            try {
                // 优先使用 SDK 的 downloadFile 方法下载（带超时保护）
                const result = await withTimeout(wsClient.downloadFile(imageUrl, imageAesKey), IMAGE_DOWNLOAD_TIMEOUT_MS, `Image download timed out: ${imageUrl}`);
                imageBuffer = result.buffer;
                originalFilename = result.filename;
                imageContentType = await detectImageContentType(imageBuffer);
                logWeCom(runtime, "Image downloaded via SDK", {
                    imageUrl,
                    sizeBytes: imageBuffer.length,
                    contentType: imageContentType,
                    filename: originalFilename,
                });
            }
            catch (sdkError) {
                logWeCom(runtime, "Image SDK download failed; falling back to manual fetch", {
                    imageUrl,
                    error: String(sdkError),
                });
                const fetched = await withTimeout(core.channel.media.fetchRemoteMedia({ url: imageUrl }), IMAGE_DOWNLOAD_TIMEOUT_MS, `Manual image download timed out: ${imageUrl}`);
                imageBuffer = fetched.buffer;
                imageContentType = fetched.contentType ?? "application/octet-stream";
                const isValidImage = await isImageBuffer(fetched.buffer);
                if (!isValidImage) {
                    logWeCom(runtime, "Image payload does not look like a standard image", {
                        imageUrl,
                        contentType: imageContentType,
                    });
                }
            }
            const saved = await saveInboundMediaBuffer({
                buffer: imageBuffer,
                contentType: imageContentType,
                originalFilename,
                cfg: config,
                runtime,
                kind: "image",
            });
            mediaList.push({ path: saved.path, contentType: saved.contentType });
            logWeCom(runtime, "Image saved", {
                imageUrl,
                path: saved.path,
                contentType: saved.contentType,
            });
        }
        catch (err) {
            const message = err?.code === "too-large"
                ? `已收到图片，但大小超过 ${resolveWeComMediaConfig(config, runtime).maxMb}MB 上限，未处理。`
                : "已收到图片，但读取失败，未处理。";
            notices.push(message);
            logWeComError(runtime, "Failed to download image", { imageUrl, error: String(err) });
        }
    }
    return { mediaList, notices };
}
/**
 * 下载并保存所有文件到本地，每个文件的下载带超时保护
 */
async function downloadAndSaveFiles(params) {
    const { fileUrls, config, runtime, wsClient } = params;
    const core = getWeComRuntime();
    const mediaList = [];
    const notices = [];
    for (const fileUrl of fileUrls) {
        let originalFilename;
        try {
            logWeCom(runtime, "Downloading file", { fileUrl });
            let fileBuffer;
            let fileContentType;
            const fileAesKey = params.fileAesKeys?.get(fileUrl);
            try {
                // 使用 SDK 的 downloadFile 方法下载（带超时保护）
                const result = await withTimeout(wsClient.downloadFile(fileUrl, fileAesKey), FILE_DOWNLOAD_TIMEOUT_MS, `File download timed out: ${fileUrl}`);
                fileBuffer = result.buffer;
                originalFilename = result.filename;
                const type = await fileTypeFromBuffer(fileBuffer);
                fileContentType = type?.mime ?? "application/octet-stream";
                logWeCom(runtime, "File downloaded via SDK", {
                    fileUrl,
                    sizeBytes: fileBuffer.length,
                    contentType: fileContentType,
                    filename: originalFilename,
                });
            }
            catch (sdkError) {
                logWeCom(runtime, "File SDK download failed; falling back to manual fetch", {
                    fileUrl,
                    error: String(sdkError),
                });
                const fetched = await withTimeout(core.channel.media.fetchRemoteMedia({ url: fileUrl }), FILE_DOWNLOAD_TIMEOUT_MS, `Manual file download timed out: ${fileUrl}`);
                fileBuffer = fetched.buffer;
                fileContentType = fetched.contentType ?? "application/octet-stream";
                originalFilename = originalFilename ?? path.basename(new URL(fileUrl).pathname || "document");
            }
            const saved = await saveInboundMediaBuffer({
                buffer: fileBuffer,
                contentType: fileContentType,
                originalFilename,
                cfg: config,
                runtime,
                kind: "file",
            });
            mediaList.push({ path: saved.path, contentType: saved.contentType });
            logWeCom(runtime, "File saved", {
                fileUrl,
                path: saved.path,
                contentType: saved.contentType,
            });
        }
        catch (err) {
            notices.push(buildFileFailureNotice(originalFilename, err, config, runtime));
            logWeComError(runtime, "Failed to download file", { fileUrl, error: String(err) });
        }
    }
    return { mediaList, notices };
}

/**
 * 企业微信群组访问控制模块
 *
 * 负责群组策略检查（groupPolicy、群组白名单、群内发送者白名单）
 */
// ============================================================================
// 内部辅助函数
// ============================================================================
/**
 * 解析企业微信群组配置
 */
function resolveWeComGroupConfig(params) {
    const groups = params.cfg?.groups ?? {};
    const wildcard = groups["*"];
    const groupId = params.groupId?.trim();
    if (!groupId) {
        return undefined;
    }
    const direct = groups[groupId];
    if (direct) {
        return direct;
    }
    const lowered = groupId.toLowerCase();
    const matchKey = Object.keys(groups).find((key) => key.toLowerCase() === lowered);
    if (matchKey) {
        return groups[matchKey];
    }
    return wildcard;
}
/**
 * 检查群组是否在允许列表中
 */
function isWeComGroupAllowed(params) {
    const { groupPolicy } = params;
    if (groupPolicy === "disabled") {
        return false;
    }
    if (groupPolicy === "open") {
        return true;
    }
    // allowlist 模式：检查群组是否在允许列表中
    const normalizedAllowFrom = params.allowFrom.map((entry) => String(entry).replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim());
    if (normalizedAllowFrom.includes("*")) {
        return true;
    }
    const normalizedGroupId = params.groupId.trim();
    return normalizedAllowFrom.some((entry) => entry === normalizedGroupId || entry.toLowerCase() === normalizedGroupId.toLowerCase());
}
/**
 * 检查群组内发送者是否在允许列表中
 */
function isGroupSenderAllowed(params) {
    const { senderId, groupId, wecomConfig } = params;
    const groupConfig = resolveWeComGroupConfig({
        cfg: wecomConfig,
        groupId,
    });
    const perGroupSenderAllowFrom = (groupConfig?.allowFrom ?? []).map((v) => String(v));
    if (perGroupSenderAllowFrom.length === 0) {
        return true;
    }
    if (perGroupSenderAllowFrom.includes("*")) {
        return true;
    }
    return perGroupSenderAllowFrom.some((entry) => {
        const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
        return normalized === senderId || normalized === `user:${senderId}`;
    });
}
// ============================================================================
// 公开 API
// ============================================================================
/**
 * 检查群组策略访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
function checkGroupPolicy(params) {
    const { chatId, senderId, account, config, runtime } = params;
    const wecomConfig = (config.channels?.[CHANNEL_ID] ?? {});
    const defaultGroupPolicy = config.channels?.[CHANNEL_ID]?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
    // const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    //   providerConfigPresent: config.channels?.[CHANNEL_ID] !== undefined,
    //   groupPolicy: wecomConfig.groupPolicy,
    //   defaultGroupPolicy,
    // });
    // warnMissingProviderGroupPolicyFallbackOnce({
    //   providerMissingFallbackApplied,
    //   providerKey: CHANNEL_ID,
    //   accountId: account.accountId,
    //   log: (msg) => runtime.log?.(msg),
    // });
    const groupAllowFrom = wecomConfig.groupAllowFrom ?? [];
    const groupAllowed = isWeComGroupAllowed({
        groupPolicy,
        allowFrom: groupAllowFrom,
        groupId: chatId,
    });
    if (!groupAllowed) {
        runtime.log?.(`[WeCom] Group ${chatId} not allowed (groupPolicy=${groupPolicy})`);
        return { allowed: false };
    }
    const senderAllowed = isGroupSenderAllowed({
        senderId,
        groupId: chatId,
        wecomConfig,
    });
    if (!senderAllowed) {
        runtime.log?.(`[WeCom] Sender ${senderId} not in group ${chatId} sender allowlist`);
        return { allowed: false };
    }
    return { allowed: true };
}
/**
 * 检查发送者是否在允许列表中（通用）
 */
function isSenderAllowed(senderId, allowFrom) {
    if (allowFrom.includes("*")) {
        return true;
    }
    return allowFrom.some((entry) => {
        const normalized = entry.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
        return normalized === senderId || normalized === `user:${senderId}`;
    });
}

/**
 * 企业微信 DM（私聊）访问控制模块
 *
 * 负责私聊策略检查、配对流程
 */
// ============================================================================
// 公开 API
// ============================================================================
/**
 * 检查 DM Policy 访问控制
 * @returns 检查结果，包含是否允许继续处理
 */
async function checkDmPolicy(params) {
    const { senderId, isGroup, account, wsClient, frame, runtime } = params;
    const core = getWeComRuntime();
    // 群聊消息不检查 DM Policy
    if (isGroup) {
        return { allowed: true };
    }
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
    // 如果 dmPolicy 是 disabled，直接拒绝
    if (dmPolicy === "disabled") {
        runtime.log?.(`[WeCom] Blocked DM from ${senderId} (dmPolicy=disabled)`);
        return { allowed: false };
    }
    // 如果是 open 模式，允许所有人
    if (dmPolicy === "open") {
        return { allowed: true };
    }
    // OpenClaw <= 2026.2.19 signature: readAllowFromStore(channel, env?, accountId?)
    const oldStoreAllowFrom = await core.channel.pairing.readAllowFromStore('wecom', undefined, account.accountId).catch(() => []);
    // Compatibility fallback for newer OpenClaw implementations.
    const newStoreAllowFrom = await core.channel.pairing
        .readAllowFromStore({ channel: CHANNEL_ID, accountId: account.accountId })
        .catch(() => []);
    // 检查发送者是否在允许列表中
    const storeAllowFrom = [...oldStoreAllowFrom, ...newStoreAllowFrom];
    const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const senderAllowedResult = isSenderAllowed(senderId, effectiveAllowFrom);
    if (senderAllowedResult) {
        return { allowed: true };
    }
    // 处理未授权用户
    if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderId,
            accountId: account.accountId,
            meta: { name: senderId },
        });
        if (created) {
            runtime.log?.(`[WeCom] Pairing request created for sender=${senderId}`);
            try {
                await sendWeComReply({
                    wsClient,
                    frame,
                    text: core.channel.pairing.buildPairingReply({
                        channel: CHANNEL_ID,
                        idLine: `您的企业微信用户ID: ${senderId}`,
                        code,
                    }),
                    runtime,
                    finish: true,
                });
            }
            catch (err) {
                runtime.error?.(`[WeCom] Failed to send pairing reply to ${senderId}: ${String(err)}`);
            }
        }
        else {
            runtime.log?.(`[WeCom] Pairing request already exists for sender=${senderId}`);
        }
        return { allowed: false, pairingSent: created };
    }
    // allowlist 模式：直接拒绝未授权用户
    runtime.log?.(`[WeCom] Blocked unauthorized sender ${senderId} (dmPolicy=${dmPolicy})`);
    return { allowed: false };
}

// ============================================================================
// 常量
// ============================================================================
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const DEFAULT_MEMORY_MAX_SIZE = 200;
const DEFAULT_FILE_MAX_ENTRIES = 500;
const DEFAULT_FLUSH_DEBOUNCE_MS = 1000;
const DEFAULT_LOCK_OPTIONS = {
    stale: 60000,
    retries: {
        retries: 6,
        factor: 1.35,
        minTimeout: 8,
        maxTimeout: 180,
        randomize: true,
    },
};
// ============================================================================
// 状态目录解析
// ============================================================================
function resolveStateDirFromEnv(env = process.env) {
    const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
    if (stateOverride) {
        return stateOverride;
    }
    if (env.VITEST || env.NODE_ENV === "test") {
        return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
    }
    return path.join(os.homedir(), ".openclaw");
}
function resolveReqIdFilePath(accountId) {
    const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(resolveStateDirFromEnv(), "wecom", `reqid-map-${safe}.json`);
}
// ============================================================================
// 核心实现
// ============================================================================
function createPersistentReqIdStore(accountId, options) {
    const ttlMs = DEFAULT_TTL_MS;
    const memoryMaxSize = DEFAULT_MEMORY_MAX_SIZE;
    const fileMaxEntries = DEFAULT_FILE_MAX_ENTRIES;
    const flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS;
    const filePath = resolveReqIdFilePath(accountId);
    // 内存层：chatId → ReqIdEntry
    const memory = new Map();
    // 防抖写入相关
    let dirty = false;
    let flushTimer = null;
    // ========== 内部辅助函数 ==========
    /** 检查条目是否过期 */
    function isExpired(entry, now) {
        return now - entry.ts >= ttlMs;
    }
    /** 验证磁盘条目的合法性 */
    function isValidEntry(entry) {
        return (typeof entry === "object" &&
            entry !== null &&
            typeof entry.reqId === "string" &&
            typeof entry.ts === "number" &&
            Number.isFinite(entry.ts));
    }
    /** 清理磁盘数据中的无效值，返回干净的 Record */
    function sanitizeData(value) {
        if (!value || typeof value !== "object") {
            return {};
        }
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (isValidEntry(entry)) {
                out[key] = entry;
            }
        }
        return out;
    }
    /**
     * 内存容量控制：淘汰最旧的条目。
     * 利用 Map 的插入顺序 + touch(先 delete 再 set) 实现类 LRU 效果。
     */
    function pruneMemory() {
        if (memory.size <= memoryMaxSize)
            return;
        const sorted = [...memory.entries()].sort((a, b) => a[1].ts - b[1].ts);
        const toRemove = sorted.slice(0, memory.size - memoryMaxSize);
        for (const [key] of toRemove) {
            memory.delete(key);
        }
    }
    /** 磁盘数据容量控制：先清过期，再按时间淘汰超量 */
    function pruneFileData(data, now) {
        {
            for (const [key, entry] of Object.entries(data)) {
                if (now - entry.ts >= ttlMs) {
                    delete data[key];
                }
            }
        }
        const keys = Object.keys(data);
        if (keys.length <= fileMaxEntries)
            return;
        keys
            .sort((a, b) => data[a].ts - data[b].ts)
            .slice(0, keys.length - fileMaxEntries)
            .forEach((key) => delete data[key]);
    }
    /** 防抖写入磁盘 */
    function scheduleDiskFlush() {
        dirty = true;
        if (flushTimer)
            return;
        flushTimer = setTimeout(async () => {
            flushTimer = null;
            if (!dirty)
                return;
            await flushToDisk();
        }, flushDebounceMs);
    }
    /** 立即写入磁盘（带文件锁，参考 createPersistentDedupe 的 checkAndRecordInner） */
    async function flushToDisk() {
        dirty = false;
        const now = Date.now();
        try {
            await withFileLock(filePath, DEFAULT_LOCK_OPTIONS, async () => {
                // 读取现有磁盘数据并合并
                const { value } = await readJsonFileWithFallback(filePath, {});
                const data = sanitizeData(value);
                // 将内存中未过期的数据合并到磁盘数据（内存优先）
                for (const [chatId, entry] of memory) {
                    if (!isExpired(entry, now)) {
                        data[chatId] = entry;
                    }
                }
                // 清理过期和超量
                pruneFileData(data, now);
                // 原子写入
                await writeJsonFileAtomically(filePath, data);
            });
        }
        catch (error) {
            // 磁盘写入失败不影响内存使用，降级到纯内存模式
            // console.error(`[WeCom] reqid-store: flush to disk failed: ${String(error)}`);
        }
    }
    // ========== 公开 API ==========
    function set(chatId, reqId) {
        const entry = { reqId, ts: Date.now() };
        // touch：先删再设，保持 Map 插入顺序（类 LRU）
        memory.delete(chatId);
        memory.set(chatId, entry);
        pruneMemory();
        scheduleDiskFlush();
    }
    async function get(chatId) {
        const now = Date.now();
        // 1. 先查内存
        const memEntry = memory.get(chatId);
        if (memEntry && !isExpired(memEntry, now)) {
            return memEntry.reqId;
        }
        if (memEntry) {
            memory.delete(chatId); // 过期则删除
        }
        // 2. 内存 miss，回查磁盘并回填内存
        try {
            const { value } = await readJsonFileWithFallback(filePath, {});
            const data = sanitizeData(value);
            const diskEntry = data[chatId];
            if (diskEntry && !isExpired(diskEntry, now)) {
                // 回填内存
                memory.set(chatId, diskEntry);
                return diskEntry.reqId;
            }
        }
        catch {
            // 磁盘读取失败，降级返回 undefined
        }
        return undefined;
    }
    function getSync(chatId) {
        const now = Date.now();
        const entry = memory.get(chatId);
        if (entry && !isExpired(entry, now)) {
            return entry.reqId;
        }
        if (entry) {
            memory.delete(chatId);
        }
        return undefined;
    }
    function del(chatId) {
        memory.delete(chatId);
        scheduleDiskFlush();
    }
    async function warmup(onError) {
        const now = Date.now();
        try {
            const { value } = await readJsonFileWithFallback(filePath, {});
            const data = sanitizeData(value);
            let loaded = 0;
            for (const [chatId, entry] of Object.entries(data)) {
                if (!isExpired(entry, now)) {
                    memory.set(chatId, entry);
                    loaded++;
                }
            }
            pruneMemory();
            return loaded;
        }
        catch (error) {
            onError?.(error);
            return 0;
        }
    }
    async function flush() {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        await flushToDisk();
    }
    function clearMemory() {
        memory.clear();
    }
    function memorySize() {
        return memory.size;
    }
    return {
        set,
        get,
        getSync,
        delete: del,
        warmup,
        flush,
        clearMemory,
        memorySize,
    };
}

/**
 * 企业微信全局状态管理模块
 *
 * 负责管理 WSClient 实例、消息状态（带 TTL 清理）、ReqId 存储
 * 解决全局 Map 的内存泄漏问题
 */
// ============================================================================
// WSClient 实例管理
// ============================================================================
/** WSClient 实例管理 */
const wsClientInstances = new Map();
/**
 * 获取指定账户的 WSClient 实例
 */
function getWeComWebSocket(accountId) {
    return wsClientInstances.get(accountId) ?? null;
}
/**
 * 设置指定账户的 WSClient 实例
 */
function setWeComWebSocket(accountId, client) {
    wsClientInstances.set(accountId, client);
}
/** 消息状态管理 */
const messageStates = new Map();
/** 定期清理定时器 */
let cleanupTimer = null;
/**
 * 启动消息状态定期清理（自动 TTL 清理 + 容量限制）
 */
function startMessageStateCleanup() {
    if (cleanupTimer)
        return;
    cleanupTimer = setInterval(() => {
        pruneMessageStates();
    }, MESSAGE_STATE_CLEANUP_INTERVAL_MS);
    // 允许进程退出时不阻塞
    if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
        cleanupTimer.unref();
    }
}
/**
 * 停止消息状态定期清理
 */
function stopMessageStateCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}
/**
 * 清理过期和超量的消息状态条目
 */
function pruneMessageStates() {
    const now = Date.now();
    // 1. 清理过期条目
    for (const [key, entry] of messageStates) {
        if (now - entry.createdAt >= MESSAGE_STATE_TTL_MS) {
            messageStates.delete(key);
        }
    }
    // 2. 容量限制：如果仍超过最大条目数，按时间淘汰最旧的
    if (messageStates.size > MESSAGE_STATE_MAX_SIZE) {
        const sorted = [...messageStates.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toRemove = sorted.slice(0, messageStates.size - MESSAGE_STATE_MAX_SIZE);
        for (const [key] of toRemove) {
            messageStates.delete(key);
        }
    }
}
/**
 * 设置消息状态
 */
function setMessageState(messageId, state) {
    messageStates.set(messageId, {
        state,
        createdAt: Date.now(),
    });
}
/**
 * 删除消息状态
 */
function deleteMessageState(messageId) {
    messageStates.delete(messageId);
}
// ============================================================================
// ReqId 持久化存储管理（按 accountId 隔离）
// ============================================================================
/**
 * ReqId 持久化存储管理
 * 参考 createPersistentDedupe 模式：内存 + 磁盘双层、文件锁、原子写入、TTL 过期、防抖写入
 * 重启后可从磁盘恢复，确保主动推送消息时能获取到 reqId
 */
const reqIdStores = new Map();
function getOrCreateReqIdStore(accountId) {
    let store = reqIdStores.get(accountId);
    if (!store) {
        store = createPersistentReqIdStore(accountId);
        reqIdStores.set(accountId, store);
    }
    return store;
}
// ============================================================================
// ReqId 操作函数
// ============================================================================
/**
 * 设置 chatId 对应的 reqId（写入内存 + 防抖写磁盘）
 */
function setReqIdForChat(chatId, reqId, accountId = "default") {
    getOrCreateReqIdStore(accountId).set(chatId, reqId);
}
/**
 * 启动时预热 reqId 缓存（从磁盘加载到内存）
 */
async function warmupReqIdStore(accountId = "default", log) {
    const store = getOrCreateReqIdStore(accountId);
    return store.warmup((error) => {
        log?.(`[WeCom] reqid-store warmup error: ${String(error)}`);
    });
}
// ============================================================================
// 全局 cleanup（断开连接时释放所有资源）
// ============================================================================
/**
 * 清理指定账户的所有资源
 */
async function cleanupAccount(accountId) {
    // 1. 断开 WSClient
    const wsClient = wsClientInstances.get(accountId);
    if (wsClient) {
        try {
            wsClient.disconnect();
        }
        catch {
            // 忽略断开连接时的错误
        }
        wsClientInstances.delete(accountId);
    }
    // 2. flush reqId 存储到磁盘
    const store = reqIdStores.get(accountId);
    if (store) {
        try {
            await store.flush();
        }
        catch {
            // 忽略 flush 错误
        }
        // 注意：不删除 store，因为重连后可能还需要
    }
}

/**
 * 企业微信 WebSocket 监控器主模块
 *
 * 负责：
 * - 建立和管理 WebSocket 连接
 * - 协调消息处理流程（解析→策略检查→下载图片→路由回复）
 * - 资源生命周期管理
 *
 * 子模块：
 * - message-parser.ts  : 消息内容解析
 * - message-sender.ts  : 消息发送（带超时保护）
 * - media-handler.ts   : 图片下载和保存（带超时保护）
 * - group-policy.ts    : 群组访问控制
 * - dm-policy.ts       : 私聊访问控制
 * - state-manager.ts   : 全局状态管理（带 TTL 清理）
 * - timeout.ts         : 超时工具
 */
// ============================================================================
// 消息上下文构建
// ============================================================================
/**
 * 构建消息上下文
 */
function buildMessageContext(frame, account, config, text, mediaList, quoteContent, options = {}) {
    const core = getWeComRuntime();
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const chatType = body.chattype === "group" ? "group" : "direct";
    // 解析路由信息
    const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        peer: {
            kind: chatType,
            id: chatId,
        },
    });
    // 构建会话标签
    const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${body.from.userid}`;
    // 当只有媒体没有文本时，使用占位符标识媒体类型
    const hasImages = mediaList.some((m) => m.contentType?.startsWith("image/"));
    const messageBody = text || (mediaList.length > 0 ? (hasImages ? MEDIA_IMAGE_PLACEHOLDER : MEDIA_DOCUMENT_PLACEHOLDER) : "");
    // 构建多媒体数组
    const mediaPaths = mediaList.length > 0 ? mediaList.map((m) => m.path) : undefined;
    const mediaTypes = mediaList.length > 0
        ? mediaList.map((m) => m.contentType).filter(Boolean)
        : undefined;
    // 构建标准消息上下文
    return core.channel.reply.finalizeInboundContext({
        Body: messageBody,
        RawBody: messageBody,
        CommandBody: messageBody,
        MessageSid: body.msgid,
        From: chatType === "group" ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${body.from.userid}`,
        To: `${CHANNEL_ID}:${chatId}`,
        SenderId: body.from.userid,
        SessionKey: route.sessionKey,
        AccountId: account.accountId,
        ChatType: chatType,
        ConversationLabel: fromLabel,
        Timestamp: Date.now(),
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: `${CHANNEL_ID}:${chatId}`,
        CommandAuthorized: options.commandAuthorized ?? true,
        OwnerAllowFrom: options.ownerAllowFrom,
        ResponseUrl: body.response_url,
        ReqId: frame.headers.req_id,
        WeComFrame: frame,
        MediaPath: mediaList[0]?.path,
        MediaType: mediaList[0]?.contentType,
        MediaPaths: mediaPaths,
        MediaTypes: mediaTypes,
        MediaUrls: mediaPaths,
        ReplyToBody: quoteContent,
    });
}
// ============================================================================
// 消息处理和回复
// ============================================================================
/**
 * 发送"思考中"消息
 */
async function sendThinkingReply(params) {
    const { wsClient, frame, streamId, runtime } = params;
    runtime.log?.(`[WeCom] Sending thinking message`);
    try {
        await sendWeComReply({
            wsClient,
            frame,
            text: THINKING_MESSAGE,
            runtime,
            finish: false,
            streamId,
        });
    }
    catch (err) {
        runtime.error?.(`[WeCom] Failed to send thinking message: ${String(err)}`);
    }
}
/**
 * 路由消息到核心处理流程并处理回复
 */
async function routeAndDispatchMessage(params) {
    const { ctxPayload, config, wsClient, frame, state, runtime, onCleanup } = params;
    const core = getWeComRuntime();
    // 防止 onCleanup 被多次调用（onError 回调与 catch 块可能重复触发）
    let cleanedUp = false;
    const safeCleanup = () => {
        if (!cleanedUp) {
            cleanedUp = true;
            onCleanup();
        }
    };
    try {
        await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: config,
            dispatcherOptions: {
                deliver: async (payload, info) => {
                    const approvalGate = getSessionApprovalGate(ctxPayload.SessionKey);
                    if (approvalGate) {
                        if (state.pendingApprovalId !== approvalGate.approvalId) {
                            state.pendingApprovalId = approvalGate.approvalId;
                            state.pendingApprovalPlaceholder = buildApprovalPendingPlaceholder(approvalGate);
                            state.accumulatedText = "";
                            await sendWeComReply({
                                wsClient,
                                frame,
                                text: state.pendingApprovalPlaceholder,
                                runtime,
                                finish: false,
                                streamId: state.streamId,
                            });
                        }
                        return;
                    }
                    state.accumulatedText += payload.text;
                    if (info.kind !== "final") {
                        await sendWeComReply({
                            wsClient,
                            frame,
                            text: state.accumulatedText,
                            runtime,
                            finish: false,
                            streamId: state.streamId,
                        });
                    }
                },
                onError: (err, info) => {
                    runtime.error?.(`[WeCom] ${info.kind} reply failed: ${String(err)}`);
                    // 仅记录错误，不立即 cleanup，让外层 try/catch 统一处理最终回复和 cleanup
                },
            },
        });
        // 发送最终消息
        const finalText = state.accumulatedText || state.pendingApprovalPlaceholder;
        if (finalText) {
            await sendWeComReply({
                wsClient,
                frame,
                text: finalText,
                runtime,
                finish: true,
                streamId: state.streamId,
            });
        }
        safeCleanup();
    }
    catch (err) {
        runtime.error?.(`[WeCom] Failed to process message: ${String(err)}`);
        safeCleanup();
    }
}
function resolvePendingApprovalByInput(input) {
    const normalized = String(input ?? "").trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    for (const approval of pendingApprovals.values()) {
        if (approval.id.toLowerCase() === normalized || approval.slug.toLowerCase() === normalized) {
            return approval;
        }
    }
    return undefined;
}
function formatPendingApprovalsSummary() {
    const rows = [...pendingApprovals.values()]
        .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
        .slice(0, 10)
        .map((approval) => `- ${approval.slug} -> ${approval.deliveryContext?.to ?? approval.sessionKey}`);
    return rows.length > 0 ? rows.join("\n") : "当前没有待审批的执行请求。";
}
async function maybeHandleWeComApprovalCommand(params) {
    const shortcutDecision = parseWeComApprovalShortcut(params.text);
    const parsed = parseWeComApprovalCommand(params.text);
    if (!parsed && !shortcutDecision) {
        return false;
    }
    const approvalConfig = resolveWeComApprovalConfig(params.cfg);
    if (!approvalConfig.enabled) {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: "执行审批当前未启用。",
            runtime: params.runtime,
        });
        return true;
    }
    if (!params.commandAccess.senderIsOwner) {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: "只有管理员可以审批执行请求。",
            runtime: params.runtime,
        });
        return true;
    }
    if (approvalConfig.dmOnly && params.chatType !== "direct") {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: "执行审批只能在管理员私聊中完成。",
            runtime: params.runtime,
        });
        return true;
    }
    if (shortcutDecision) {
        const pending = resolveLatestPendingApprovalForApprover(params.senderId);
        if (!pending) {
            await sendWeComReply({
                wsClient: params.wsClient,
                frame: params.frame,
                text: "当前没有待审批的执行请求。",
                runtime: params.runtime,
            });
            return true;
        }
        try {
            await resolveApprovalViaGateway(pending.id, shortcutDecision, params.runtime);
            const resolvedApproval = clearPendingApproval(pending.id) ?? pending;
            if (shortcutDecision !== "deny") {
                rememberResolvedApprovalAwaitingCompletion(resolvedApproval);
            }
            const shortcutLabel = params.text.trim().toUpperCase();
            const requesterText = shortcutDecision === "deny"
                ? `执行审批已拒绝。\nRequest ID: ${pending.slug}`
                : `执行审批已批准，等待执行完成。\nRequest ID: ${pending.slug}`;
            await notifyApprovalRequester(pending, requesterText);
            await sendWeComReply({
                wsClient: params.wsClient,
                frame: params.frame,
                text: `已选择 ${shortcutLabel}: ${pending.slug}`,
                runtime: params.runtime,
            });
        }
        catch (err) {
            logWeComError(params.runtime, "Failed to resolve approval", {
                approvalId: pending.id,
                decision: shortcutDecision,
                error: String(err),
            });
            await sendWeComReply({
                wsClient: params.wsClient,
                frame: params.frame,
                text: `审批提交失败: ${pending.slug}\n${truncateForLog(String(err), 400)}`,
                runtime: params.runtime,
            });
        }
        return true;
    }
    if (!parsed.id || !parsed.decision) {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: ["请直接回复 A / B / C。", "A = allow-once", "B = allow-always", "C = deny", "", formatPendingApprovalsSummary()].join("\n"),
            runtime: params.runtime,
        });
        return true;
    }
    if (!APPROVAL_DECISIONS.has(parsed.decision)) {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: "无效审批动作。请直接回复 A / B / C。",
            runtime: params.runtime,
        });
        return true;
    }
    const pending = resolvePendingApprovalByInput(parsed.id);
    if (!pending) {
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: `未找到待审批请求: ${parsed.id}`,
            runtime: params.runtime,
        });
        return true;
    }
    try {
        await resolveApprovalViaGateway(pending.id, parsed.decision, params.runtime);
        const resolvedApproval = clearPendingApproval(pending.id) ?? pending;
        if (parsed.decision !== "deny") {
            rememberResolvedApprovalAwaitingCompletion(resolvedApproval);
        }
        const requesterText = parsed.decision === "deny"
            ? `执行审批已拒绝。\nRequest ID: ${pending.slug}`
            : `执行审批已批准，等待执行完成。\nRequest ID: ${pending.slug}`;
        await notifyApprovalRequester(pending, requesterText);
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: `审批已提交: ${pending.slug} -> ${parsed.decision}`,
            runtime: params.runtime,
        });
    }
    catch (err) {
        logWeComError(params.runtime, "Failed to resolve approval", {
            approvalId: pending.id,
            decision: parsed.decision,
            error: String(err),
        });
        await sendWeComReply({
            wsClient: params.wsClient,
            frame: params.frame,
            text: `审批提交失败: ${pending.slug}\n${truncateForLog(String(err), 400)}`,
            runtime: params.runtime,
        });
    }
    return true;
}
/**
 * 处理企业微信消息（主函数）
 *
 * 处理流程：
 * 1. 解析消息内容（文本、图片、引用）
 * 2. 群组策略检查（仅群聊）
 * 3. DM Policy 访问控制检查（仅私聊）
 * 4. 下载并保存图片
 * 5. 初始化消息状态
 * 6. 发送"思考中"消息
 * 7. 路由消息到核心处理流程
 *
 * 整体带超时保护，防止单条消息处理阻塞过久
 */
async function processWeComMessage(params) {
    const { frame, account, config, runtime, wsClient } = params;
    let effectiveConfig = config;
    let effectiveAccount = resolveWeComAccount(effectiveConfig);
    let pendingProvisionPersist;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    const chatType = body.chattype === "group" ? "group" : "direct";
    const messageId = body.msgid;
    const reqId = frame.headers.req_id;
    // Step 1: 解析消息内容
    const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } = parseMessageContent(body);
    const rawText = textParts.join("\n").trim();
    let text = rawText;
    // 群聊中移除 @机器人 的提及标记
    if (body.chattype === "group") {
        text = text.replace(/@\S+/g, "").trim();
    }
    // 如果文本为空但存在引用消息，使用引用消息内容
    if (!text && quoteContent) {
        text = quoteContent;
        runtime.log?.("[WeCom] Using quote content as message body (user only mentioned bot)");
    }
    // 如果既没有文本也没有图片也没有文件也没有引用内容，则跳过
    if (!text && imageUrls.length === 0 && fileUrls.length === 0) {
        runtime.log?.("[WeCom] Skipping empty message (no text, image, file or quote)");
        return effectiveConfig;
    }
    let detailSuffix = "";
    if (imageUrls.length > 0) {
        detailSuffix += " (with " + imageUrls.length + " image(s))";
    }
    if (fileUrls.length > 0) {
        detailSuffix += " (with " + fileUrls.length + " file(s))";
    }
    if (quoteContent) {
        detailSuffix += " (with quote)";
    }
    runtime.log?.("[WeCom] Processing " + chatType + " message from chat: " + chatId + " user: " + body.from.userid + " reqId: " + reqId + detailSuffix);
    // Step 2: 群组策略检查（仅群聊）
    if (chatType === "group") {
        const groupPolicyResult = checkGroupPolicy({
            chatId,
            senderId: body.from.userid,
            account: effectiveAccount,
            config: effectiveConfig,
            runtime,
        });
        if (!groupPolicyResult.allowed) {
            return effectiveConfig;
        }
    }
    // Step 3: DM Policy 访问控制检查（仅私聊）
    const dmPolicyResult = await checkDmPolicy({
        senderId: body.from.userid,
        isGroup: chatType === "group",
        account: effectiveAccount,
        wsClient,
        frame,
        runtime,
    });
    if (!dmPolicyResult.allowed) {
        return effectiveConfig;
    }
    const preflightCommandAccess = resolveWeComCommandAccess({
        cfg: effectiveConfig,
        text,
        senderId: body.from.userid,
    });
    if (await maybeHandleWeComApprovalCommand({
        text,
        cfg: effectiveConfig,
        runtime,
        wsClient,
        frame,
        chatType,
        commandAccess: preflightCommandAccess,
    })) {
        return effectiveConfig;
    }
    const autoProvision = resolveAutoProvisionConfig(effectiveConfig);
    if (autoProvision.enabled) {
        if (chatType === "group") {
            const mentionSource = rawText || quoteContent || text;
            if (!shouldHandleWeComGroupMessage({
                text: mentionSource,
                cfg: effectiveConfig,
                accountId: effectiveAccount.accountId,
                groupId: chatId,
                autoProvision,
                runtime,
            })) {
                return effectiveConfig;
            }
        }
        const provisionResult = await ensureWeComPeerProvisioned({
            cfg: effectiveConfig,
            runtime,
            accountId: effectiveAccount.accountId,
            kind: chatType === "group" ? AUTO_PROVISION_GROUP_KIND : AUTO_PROVISION_DM_KIND,
            peerId: chatId,
        });
        effectiveConfig = provisionResult.cfg;
        effectiveAccount = resolveWeComAccount(effectiveConfig);
        if (provisionResult.configChanged) {
            pendingProvisionPersist = {
                entry: provisionResult.entry,
                kind: chatType === "group" ? AUTO_PROVISION_GROUP_KIND : AUTO_PROVISION_DM_KIND,
                accountId: effectiveAccount.accountId,
            };
        }
    }
    // Step 4: 下载并保存图片和文件
    const [imageResult, fileResult] = await Promise.all([
        downloadAndSaveImages({
            imageUrls,
            imageAesKeys,
            account: effectiveAccount,
            config: effectiveConfig,
            runtime,
            wsClient,
        }),
        downloadAndSaveFiles({
            fileUrls,
            fileAesKeys,
            account: effectiveAccount,
            config: effectiveConfig,
            runtime,
            wsClient,
        }),
    ]);
    const mediaList = [...imageResult.mediaList, ...fileResult.mediaList];
    const mediaNotices = [...imageResult.notices, ...fileResult.notices];
    if (mediaNotices.length > 0 && !text && mediaList.length === 0) {
        await sendWeComReply({
            wsClient,
            frame,
            text: mediaNotices.join("\n\n"),
            runtime,
        });
        return effectiveConfig;
    }
    if (mediaNotices.length > 0) {
        text = [text, mediaNotices.join("\n\n")].filter(Boolean).join("\n\n");
    }
    // Step 5: 初始化消息状态
    setReqIdForChat(chatId, reqId, effectiveAccount.accountId);
    const streamId = generateReqId("stream");
    const state = {
        accumulatedText: "",
        streamId,
        pendingApprovalId: "",
        pendingApprovalPlaceholder: "",
    };
    setMessageState(messageId, state);
    const cleanupState = () => {
        deleteMessageState(messageId);
    };
    // Step 6: 发送"思考中"消息
    const shouldSendThinking = effectiveAccount.sendThinkingMessage ?? true;
    if (shouldSendThinking) {
        await sendThinkingReply({ wsClient, frame, streamId, runtime });
    }
    // Step 7: 构建上下文并路由到核心处理流程（带整体超时保护）
    const commandAccess = resolveWeComCommandAccess({
        cfg: effectiveConfig,
        text,
        senderId: body.from.userid,
    });
    const ctxPayload = buildMessageContext(frame, effectiveAccount, effectiveConfig, text, mediaList, quoteContent, {
        commandAuthorized: commandAccess.commandAuthorized,
        ownerAllowFrom: commandAccess.ownerAllowFrom,
    });
    try {
        await withTimeout(routeAndDispatchMessage({
            ctxPayload,
            config: effectiveConfig,
            wsClient,
            frame,
            state,
            runtime,
            onCleanup: cleanupState,
        }), MESSAGE_PROCESS_TIMEOUT_MS, `Message processing timed out (msgId=${messageId})`);
    }
    catch (err) {
        runtime.error?.(`[WeCom] Message processing failed or timed out: ${String(err)}`);
        cleanupState();
    }
    if (pendingProvisionPersist) {
        try {
            effectiveConfig = await persistProvisionedConfig({
                cfg: effectiveConfig,
                ...pendingProvisionPersist,
            });
        }
        catch (err) {
            runtime.error?.("[WeCom] Failed to persist auto-provision config: " + String(err));
        }
    }
    return effectiveConfig;
}
// ============================================================================
// 创建 SDK Logger 适配器
// ============================================================================
/**
 * 创建适配 RuntimeEnv 的 Logger
 */
function createSdkLogger(runtime, accountId) {
    return {
        debug: (message, ...args) => {
            runtime.log?.(`[${accountId}] ${message}`, sanitizeForLog(args));
        },
        info: (message, ...args) => {
            runtime.log?.(`[${accountId}] ${message}`, sanitizeForLog(args));
        },
        warn: (message, ...args) => {
            runtime.log?.(`[${accountId}] WARN: ${message}`, sanitizeForLog(args));
        },
        error: (message, ...args) => {
            runtime.error?.(`[${accountId}] ${message}`, sanitizeForLog(args));
        },
    };
}
// ============================================================================
// 主函数
// ============================================================================
/**
 * 监听企业微信 WebSocket 连接
 * 使用 aibot-node-sdk 简化连接管理
 */
async function monitorWeComProvider(options) {
    const { account, runtime, abortSignal } = options;
    let currentConfig = options.config;
    runtime.log?.(`[${account.accountId}] Initializing WSClient with SDK...`);
    // 启动消息状态定期清理
    startMessageStateCleanup();
    return new Promise((resolve, reject) => {
        const logger = createSdkLogger(runtime, account.accountId);
        const wsClient = new WSClient({
            botId: account.botId,
            secret: account.secret,
            wsUrl: account.websocketUrl,
            logger,
            heartbeatInterval: WS_HEARTBEAT_INTERVAL_MS,
            maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS,
        });
        // 清理函数：确保所有资源被释放
        const cleanup = async () => {
            stopMessageStateCleanup();
            await cleanupAccount(account.accountId);
        };
        // 处理中止信号
        if (abortSignal) {
            abortSignal.addEventListener("abort", async () => {
                runtime.log?.(`[${account.accountId}] Connection aborted`);
                await cleanup();
                resolve();
            });
        }
        // 监听连接事件
        wsClient.on("connected", () => {
            runtime.log?.(`[${account.accountId}] WebSocket connected`);
        });
        // 监听认证成功事件
        wsClient.on("authenticated", () => {
            runtime.log?.(`[${account.accountId}] Authentication successful`);
            setWeComWebSocket(account.accountId, wsClient);
        });
        // 监听断开事件
        wsClient.on("disconnected", (reason) => {
            runtime.log?.(`[${account.accountId}] WebSocket disconnected: ${reason}`);
        });
        // 监听重连事件
        wsClient.on("reconnecting", (attempt) => {
            runtime.log?.(`[${account.accountId}] Reconnecting attempt ${attempt}...`);
        });
        // 监听错误事件
        wsClient.on("error", (error) => {
            runtime.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);
            // 认证失败时拒绝 Promise
            if (error.message.includes("Authentication failed")) {
                cleanup().finally(() => reject(error));
            }
        });
        // 监听所有消息
        wsClient.on("message", async (frame) => {
            try {
                currentConfig = await processWeComMessage({
                    frame,
                    account,
                    config: currentConfig,
                    runtime,
                    wsClient,
                });
            }
            catch (err) {
                runtime.error?.(`[${account.accountId}] Failed to process message: ${String(err)}`);
            }
        });
        // 启动前预热 reqId 缓存，确保完成后再建立连接，避免 getSync 在预热完成前返回 undefined
        warmupReqIdStore(account.accountId, (...args) => runtime.log?.(...args))
            .then((count) => {
            runtime.log?.(`[${account.accountId}] Warmed up ${count} reqId entries from disk`);
        })
            .catch((err) => {
            runtime.error?.(`[${account.accountId}] Failed to warmup reqId store: ${String(err)}`);
        })
            .finally(() => {
            // 无论预热成功或失败，都建立连接
            wsClient.connect();
        });
    });
}

/**
 * 企业微信公共工具函数
 */
const DefaultWsUrl = "wss://openws.work.weixin.qq.com";
const wecomPluginConfigSchema = {
    type: "object",
    additionalProperties: true,
    properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
        websocketUrl: { type: "string" },
        botId: { type: "string" },
        secret: { type: "string" },
        sendThinkingMessage: { type: "boolean" },
        allowFrom: {
            type: "array",
            items: {
                type: ["string", "number"],
            },
        },
        dmPolicy: {
            type: "string",
            enum: ["disabled", "open", "pairing", "allowlist"],
        },
        groupPolicy: {
            type: "string",
            enum: ["disabled", "open", "allowlist"],
        },
        groupAllowFrom: {
            type: "array",
            items: {
                type: ["string", "number"],
            },
        },
        configWrites: { type: "boolean" },
        groups: {
            type: "object",
            additionalProperties: true,
        },
        media: {
            type: "object",
            additionalProperties: true,
            properties: {
                maxMb: { type: "number" },
                retentionDays: { type: "number" },
                storageDir: { type: "string" },
            },
        },
        approvals: {
            type: "object",
            additionalProperties: true,
            properties: {
                enabled: { type: "boolean" },
                notifyTo: {
                    type: "array",
                    items: {
                        type: ["string", "number"],
                    },
                },
                dmOnly: { type: "boolean" },
            },
        },
        autoProvision: {
            type: "object",
            additionalProperties: true,
            properties: {
                enabled: { type: "boolean" },
                registryPath: { type: "string" },
                templateDir: { type: "string" },
                dm: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                        agentIdPrefix: { type: "string" },
                        workspaceRoot: { type: "string" },
                    },
                },
                group: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                        agentIdPrefix: { type: "string" },
                        workspaceRoot: { type: "string" },
                        requireMention: { type: "boolean" },
                    },
                },
            },
        },
    },
};
/**
 * 解析企业微信账户配置
 */
function resolveWeComAccount(cfg) {
    const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {});
    return {
        accountId: DEFAULT_ACCOUNT_ID,
        name: wecomConfig.name ?? "企业微信",
        enabled: wecomConfig.enabled ?? false,
        websocketUrl: wecomConfig.websocketUrl || DefaultWsUrl,
        botId: wecomConfig.botId ?? "",
        secret: wecomConfig.secret ?? "",
        sendThinkingMessage: wecomConfig.sendThinkingMessage ?? true,
        config: wecomConfig,
    };
}
/**
 * 设置企业微信账户配置
 */
function setWeComAccount(cfg, account) {
    const existing = (cfg.channels?.[CHANNEL_ID] ?? {});
    const merged = {
        enabled: account.enabled ?? existing?.enabled ?? true,
        botId: account.botId ?? existing?.botId ?? "",
        secret: account.secret ?? existing?.secret ?? "",
        allowFrom: account.allowFrom ?? existing?.allowFrom,
        dmPolicy: account.dmPolicy ?? existing?.dmPolicy,
        groupPolicy: account.groupPolicy ?? existing?.groupPolicy,
        groupAllowFrom: account.groupAllowFrom ?? existing?.groupAllowFrom,
        configWrites: account.configWrites ?? existing?.configWrites,
        media: account.media ?? existing?.media,
        approvals: account.approvals ?? existing?.approvals,
        autoProvision: account.autoProvision ?? existing?.autoProvision,
        groups: account.groups ?? existing?.groups,
        // 以下字段仅在已有配置值或显式传入时才写入，onboarding 时不主动生成
        ...(account.websocketUrl || existing?.websocketUrl
            ? { websocketUrl: account.websocketUrl ?? existing?.websocketUrl }
            : {}),
        ...(account.name || existing?.name
            ? { name: account.name ?? existing?.name }
            : {}),
        ...(account.sendThinkingMessage !== undefined || existing?.sendThinkingMessage !== undefined
            ? { sendThinkingMessage: account.sendThinkingMessage ?? existing?.sendThinkingMessage }
            : {}),
    };
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            [CHANNEL_ID]: merged,
        },
    };
}

/**
 * 企业微信 onboarding adapter for CLI setup wizard.
 */
const channel = CHANNEL_ID;
/**
 * 企业微信设置帮助说明
 */
async function noteWeComSetupHelp(prompter) {
    await prompter.note([
        "企业微信机器人需要以下配置信息：",
        "1. Bot ID: 企业微信机器人id",
        "2. Secret: 企业微信机器人密钥",
    ].join("\n"), "企业微信设置");
}
/**
 * 提示输入 Bot ID
 */
async function promptBotId(prompter, account) {
    return String(await prompter.text({
        message: "企业微信机器人 Bot ID",
        initialValue: account?.botId ?? "",
        validate: (value) => (value?.trim() ? undefined : "Required"),
    })).trim();
}
/**
 * 提示输入 Secret
 */
async function promptSecret(prompter, account) {
    return String(await prompter.text({
        message: "企业微信机器人 Secret",
        initialValue: account?.secret ?? "",
        validate: (value) => (value?.trim() ? undefined : "Required"),
    })).trim();
}
/**
 * 设置企业微信 dmPolicy
 */
function setWeComDmPolicy(cfg, dmPolicy) {
    const account = resolveWeComAccount(cfg);
    const existingAllowFrom = account.config.allowFrom ?? [];
    const allowFrom = dmPolicy === "open"
        ? addWildcardAllowFrom(existingAllowFrom.map((x) => String(x)))
        : existingAllowFrom.map((x) => String(x));
    return setWeComAccount(cfg, {
        dmPolicy,
        allowFrom,
    });
}
const dmPolicy = {
    label: "企业微信",
    channel,
    policyKey: `channels.${CHANNEL_ID}.dmPolicy`,
    allowFromKey: `channels.${CHANNEL_ID}.allowFrom`,
    getCurrent: (cfg) => {
        const account = resolveWeComAccount(cfg);
        return account.config.dmPolicy ?? "pairing";
    },
    setPolicy: (cfg, policy) => {
        return setWeComDmPolicy(cfg, policy);
    },
    promptAllowFrom: async ({ cfg, prompter }) => {
        const account = resolveWeComAccount(cfg);
        const existingAllowFrom = account.config.allowFrom ?? [];
        const entry = await prompter.text({
            message: "企业微信允许来源（用户ID或群组ID，每行一个，推荐用于安全控制）",
            placeholder: "user123 或 group456",
            initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
        });
        const allowFrom = String(entry ?? "")
            .split(/[\n,;]+/g)
            .map((s) => s.trim())
            .filter(Boolean);
        return setWeComAccount(cfg, { allowFrom });
    },
};
const wecomOnboardingAdapter = {
    channel,
    getStatus: async ({ cfg }) => {
        const account = resolveWeComAccount(cfg);
        const configured = Boolean(account.botId?.trim() &&
            account.secret?.trim());
        return {
            channel,
            configured,
            statusLines: [`企业微信: ${configured ? "已配置" : "需要 Bot ID 和 Secret"}`],
            selectionHint: configured ? "已配置" : "需要设置",
        };
    },
    configure: async ({ cfg, prompter, forceAllowFrom }) => {
        const account = resolveWeComAccount(cfg);
        if (!account.botId?.trim() || !account.secret?.trim()) {
            await noteWeComSetupHelp(prompter);
        }
        // 提示输入必要的配置信息：Bot ID 和 Secret
        const botId = await promptBotId(prompter, account);
        const secret = await promptSecret(prompter, account);
        // 使用默认值配置其他选项
        const cfgWithAccount = setWeComAccount(cfg, {
            botId,
            secret,
            enabled: true,
            dmPolicy: account.config.dmPolicy ?? "pairing",
            allowFrom: account.config.allowFrom ?? [],
        });
        return { cfg: cfgWithAccount };
    },
    dmPolicy,
    disable: (cfg) => {
        return setWeComAccount(cfg, { enabled: false });
    },
};

/**
 * 使用 SDK 的 sendMessage 主动发送企业微信消息
 * 无需依赖 reqId，直接向指定会话推送消息
 */
async function sendWeComMessage({ to, content, accountId, }) {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const channelPrefix = new RegExp(`^${CHANNEL_ID}:`, "i");
    const chatId = to.replace(channelPrefix, "");
    logWeCom(runtime, "Sending outbound message", {
        to,
        accountId: resolvedAccountId,
        textLength: String(content ?? "").length,
    });
    // 获取 WSClient 实例
    const wsClient = getWeComWebSocket(resolvedAccountId);
    if (!wsClient) {
        throw new Error(`WSClient not connected for account ${resolvedAccountId}`);
    }
    const result = await wsClient.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content },
    });
    const messageId = result?.headers?.req_id ?? `wecom-${Date.now()}`;
    logWeCom(runtime, "Outbound message sent", {
        chatId,
        accountId: resolvedAccountId,
        messageId,
    });
    return {
        channel: CHANNEL_ID,
        messageId,
        chatId,
    };
}
// 企业微信频道元数据
const meta = {
    id: CHANNEL_ID,
    label: "企业微信",
    selectionLabel: "企业微信 (WeCom)",
    detailLabel: "企业微信智能机器人",
    docsPath: `/channels/${CHANNEL_ID}`,
    docsLabel: CHANNEL_ID,
    blurb: "企业微信智能机器人接入插件",
    systemImage: "message.fill",
};
const wecomPlugin = {
    id: CHANNEL_ID,
    meta: {
        ...meta,
        quickstartAllowFrom: true,
    },
    pairing: {
        idLabel: "wecomUserId",
        normalizeAllowEntry: (entry) => entry.replace(new RegExp(`^(${CHANNEL_ID}|user):`, "i"), "").trim(),
        notifyApproval: async ({ cfg, id }) => {
            logWeCom(runtime, "Pairing approved", { id, accountId: cfg.accountId });
        },
    },
    onboarding: wecomOnboardingAdapter,
    capabilities: {
        chatTypes: ["direct", "group"],
        reactions: false,
        threads: false,
        media: true,
        nativeCommands: false,
        blockStreaming: true,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`, "commands", "tools.elevated", "messages", "plugins.allow"] },
    config: {
        // 列出所有账户 ID（最小实现只支持默认账户）
        listAccountIds: () => [DEFAULT_ACCOUNT_ID],
        // 解析账户配置
        resolveAccount: (cfg) => resolveWeComAccount(cfg),
        // 获取默认账户 ID
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        // 设置账户启用状态
        setAccountEnabled: ({ cfg, enabled }) => {
            const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {});
            return {
                ...cfg,
                channels: {
                    ...cfg.channels,
                    [CHANNEL_ID]: {
                        ...wecomConfig,
                        enabled,
                    },
                },
            };
        },
        // 删除账户
        deleteAccount: ({ cfg }) => {
            const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {});
            const { botId, secret, ...rest } = wecomConfig;
            return {
                ...cfg,
                channels: {
                    ...cfg.channels,
                    [CHANNEL_ID]: rest,
                },
            };
        },
        // 检查是否已配置
        isConfigured: (account) => Boolean(account.botId?.trim() && account.secret?.trim()),
        // 描述账户信息
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: Boolean(account.botId?.trim() && account.secret?.trim()),
            botId: account.botId,
            websocketUrl: account.websocketUrl,
        }),
        // 解析允许来源列表
        resolveAllowFrom: ({ cfg }) => {
            const account = resolveWeComAccount(cfg);
            return (account.config.allowFrom ?? []).map((entry) => String(entry));
        },
        // 格式化允许来源列表
        formatAllowFrom: ({ allowFrom }) => allowFrom
            .map((entry) => String(entry).trim())
            .filter(Boolean),
    },
    security: {
        resolveDmPolicy: ({ account }) => {
            const basePath = `channels.${CHANNEL_ID}.`;
            return {
                policy: account.config.dmPolicy ?? "pairing",
                allowFrom: account.config.allowFrom ?? [],
                policyPath: `${basePath}dmPolicy`,
                allowFromPath: basePath,
                approveHint: formatPairingApproveHint(CHANNEL_ID),
                normalizeEntry: (raw) => raw.replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim(),
            };
        },
        collectWarnings: ({ account, cfg }) => {
            const warnings = [];
            // DM 策略警告
            const dmPolicy = account.config.dmPolicy ?? "pairing";
            if (dmPolicy === "open") {
                const hasWildcard = (account.config.allowFrom ?? []).some((entry) => String(entry).trim() === "*");
                if (!hasWildcard) {
                    warnings.push(`- 企业微信私信：dmPolicy="open" 但 allowFrom 未包含 "*"。任何人都可以发消息，但允许列表为空可能导致意外行为。建议设置 channels.${CHANNEL_ID}.allowFrom=["*"] 或使用 dmPolicy="pairing"。`);
                }
            }
            // 群组策略警告
            const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
            const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
            const autoProvision = resolveAutoProvisionConfig(cfg);
            // const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
            //   providerConfigPresent: true,
            //   groupPolicy: account.config.groupPolicy,
            //   defaultGroupPolicy,
            // });
            if (groupPolicy === "open" && !(autoProvision.enabled && autoProvision.group.requireMention)) {
                warnings.push(`- 企业微信群组：groupPolicy="open" 允许所有群组中的成员触发。设置 channels.${CHANNEL_ID}.groupPolicy="allowlist" + channels.${CHANNEL_ID}.groupAllowFrom 来限制群组。`);
            }
            const allowedPlugins = Array.isArray(cfg.plugins?.allow) ? cfg.plugins.allow.map((entry) => String(entry)) : [];
            if (!allowedPlugins.includes("wecom-openclaw-plugin")) {
                warnings.push(`- plugins.allow 未显式包含 "wecom-openclaw-plugin"。建议设置 plugins.allow=["wecom-openclaw-plugin"]，避免插件白名单为空。`);
            }
            const approvalConfig = resolveWeComApprovalConfig(cfg);
            if (approvalConfig.enabled && approvalConfig.notifyTo.length === 0) {
                warnings.push(`- 企业微信执行审批已启用，但 channels.${CHANNEL_ID}.approvals.notifyTo 为空，也没有 ownerAllowFrom 回退；审批请求不会投递给管理员。`);
            }
            return warnings;
        },
    },
    messaging: {
        normalizeTarget: (target) => {
            const trimmed = target.trim();
            if (!trimmed)
                return undefined;
            return trimmed;
        },
        targetResolver: {
            looksLikeId: (id) => {
                const trimmed = id?.trim();
                return Boolean(trimmed);
            },
            hint: "<userId|groupId>",
        },
    },
    directory: {
        self: async () => null,
        listPeers: async () => [],
        listGroups: async () => [],
    },
    outbound: {
        deliveryMode: "direct",
        chunker: (text, limit) => getWeComRuntime().channel.text.chunkMarkdownText(text, limit),
        textChunkLimit: TEXT_CHUNK_LIMIT,
        sendText: async ({ to, text, accountId, ...rest }) => {
            logWeCom(runtime, "sendText", {
                to,
                accountId: accountId ?? DEFAULT_ACCOUNT_ID,
                textLength: String(text ?? "").length,
                meta: rest,
            });
            return sendWeComMessage({ to, content: text, accountId: accountId ?? undefined });
        },
        sendMedia: async ({ to, text, mediaUrl, accountId, ...rest }) => {
            logWeCom(runtime, "sendMedia", {
                to,
                accountId: accountId ?? DEFAULT_ACCOUNT_ID,
                textLength: String(text ?? "").length,
                hasMediaUrl: Boolean(mediaUrl),
                meta: rest,
            });
            const content = `Sending attachments is not supported yet\n${text ? `${text}\n${mediaUrl}` : (mediaUrl ?? "")}`;
            return sendWeComMessage({ to, content, accountId: accountId ?? undefined });
        },
    },
    status: {
        defaultRuntime: {
            accountId: DEFAULT_ACCOUNT_ID,
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },
        collectStatusIssues: (accounts) => accounts.flatMap((entry) => {
            const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
            const enabled = entry.enabled !== false;
            const configured = entry.configured === true;
            if (!enabled) {
                return [];
            }
            const issues = [];
            if (!configured) {
                issues.push({
                    channel: CHANNEL_ID,
                    accountId,
                    kind: "config",
                    message: "企业微信机器人 ID 或 Secret 未配置",
                    fix: "Run: openclaw channels add wecom --bot-id <id> --secret <secret>",
                });
            }
            return issues;
        }),
        buildChannelSummary: ({ snapshot }) => ({
            configured: snapshot.configured ?? false,
            running: snapshot.running ?? false,
            lastStartAt: snapshot.lastStartAt ?? null,
            lastStopAt: snapshot.lastStopAt ?? null,
            lastError: snapshot.lastError ?? null,
        }),
        probeAccount: async () => {
            return { ok: true, status: 200 };
        },
        buildAccountSnapshot: ({ account, runtime }) => {
            const configured = Boolean(account.botId?.trim() &&
                account.secret?.trim());
            return {
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured,
                running: runtime?.running ?? false,
                lastStartAt: runtime?.lastStartAt ?? null,
                lastStopAt: runtime?.lastStopAt ?? null,
                lastError: runtime?.lastError ?? null,
            };
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const cfg = await reconcileAutoProvisionedState({
                cfg: ctx.cfg,
                accountId: ctx.account.accountId,
                runtime: ctx.runtime,
            });
            pruneWeComMediaStorage(cfg, ctx.runtime);
            await primeApprovalWatcher(cfg, ctx.runtime);
            const account = resolveWeComAccount(cfg);
            // 启动 WebSocket 监听
            return monitorWeComProvider({
                account,
                config: cfg,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
            });
        },
        logoutAccount: async ({ cfg }) => {
            const nextCfg = { ...cfg };
            const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {});
            const nextWecom = { ...wecomConfig };
            let cleared = false;
            let changed = false;
            if (nextWecom.botId || nextWecom.secret) {
                delete nextWecom.botId;
                delete nextWecom.secret;
                cleared = true;
                changed = true;
            }
            if (changed) {
                if (Object.keys(nextWecom).length > 0) {
                    nextCfg.channels = { ...nextCfg.channels, [CHANNEL_ID]: nextWecom };
                }
                else {
                    const nextChannels = { ...nextCfg.channels };
                    delete nextChannels[CHANNEL_ID];
                    if (Object.keys(nextChannels).length > 0) {
                        nextCfg.channels = nextChannels;
                    }
                    else {
                        delete nextCfg.channels;
                    }
                }
                await getWeComRuntime().config.writeConfigFile(nextCfg);
            }
            const resolved = resolveWeComAccount(changed ? nextCfg : cfg);
            const loggedOut = !resolved.botId && !resolved.secret;
            return { cleared, envToken: false, loggedOut };
        },
    },
};

const plugin = {
    id: "wecom-openclaw-plugin",
    name: "企业微信",
    description: "企业微信 OpenClaw 插件",
    configSchema: wecomPluginConfigSchema,
    register(api) {
        setWeComRuntime(api.runtime);
        api.registerChannel({ plugin: wecomPlugin });
    },
};

exports.default = plugin;
//# sourceMappingURL=index.cjs.js.map
