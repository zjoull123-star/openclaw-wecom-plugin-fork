/**
 * 企业微信渠道常量定义
 */
/**
 * 企业微信渠道 ID
 */
export declare const CHANNEL_ID: "wecom";
/**
 * 企业微信 WebSocket 命令枚举
 */
export declare enum WeComCommand {
    /** 认证订阅 */
    SUBSCRIBE = "aibot_subscribe",
    /** 心跳 */
    PING = "ping",
    /** 企业微信推送消息 */
    AIBOT_CALLBACK = "aibot_callback",
    /** clawdbot 响应消息 */
    AIBOT_RESPONSE = "aibot_response"
}
/** 图片下载超时时间（毫秒） */
export declare const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
/** 文件下载超时时间（毫秒） */
export declare const FILE_DOWNLOAD_TIMEOUT_MS = 60000;
/** 消息发送超时时间（毫秒） */
export declare const REPLY_SEND_TIMEOUT_MS = 15000;
/** 消息处理总超时时间（毫秒） */
export declare const MESSAGE_PROCESS_TIMEOUT_MS: number;
/** WebSocket 心跳间隔（毫秒） */
export declare const WS_HEARTBEAT_INTERVAL_MS = 30000;
/** WebSocket 最大重连次数 */
export declare const WS_MAX_RECONNECT_ATTEMPTS = 100;
/** messageStates Map 条目的最大 TTL（毫秒），防止内存泄漏 */
export declare const MESSAGE_STATE_TTL_MS: number;
/** messageStates Map 清理间隔（毫秒） */
export declare const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60000;
/** messageStates Map 最大条目数 */
export declare const MESSAGE_STATE_MAX_SIZE = 500;
/** "思考中"流式消息占位内容 */
export declare const THINKING_MESSAGE = "<think></think>";
/** 仅包含图片时的消息占位符 */
export declare const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";
/** 仅包含文件时的消息占位符 */
export declare const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
/** 默认媒体大小上限（MB） */
export declare const DEFAULT_MEDIA_MAX_MB = 5;
/** 文本分块大小上限 */
export declare const TEXT_CHUNK_LIMIT = 4000;
