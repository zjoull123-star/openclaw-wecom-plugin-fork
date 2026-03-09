/**
 * 企业微信消息发送模块
 *
 * 负责通过 WSClient 发送回复消息，包含超时保护
 */
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { type WSClient, type WsFrame } from "@wecom/aibot-node-sdk";
/**
 * 发送企业微信回复消息
 * 供 monitor 内部和 channel outbound 使用
 *
 * @returns messageId (streamId)
 */
export declare function sendWeComReply(params: {
    wsClient: WSClient;
    frame: WsFrame;
    text?: string;
    runtime: RuntimeEnv;
    /** 是否为流式回复的最终消息，默认为 true */
    finish?: boolean;
    /** 指定 streamId，用于流式回复时保持相同的 streamId */
    streamId?: string;
}): Promise<string>;
