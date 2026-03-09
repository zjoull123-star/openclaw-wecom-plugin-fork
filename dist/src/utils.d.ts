/**
 * 企业微信公共工具函数
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk";
/**
 * 企业微信群组配置
 */
export interface WeComGroupConfig {
    /** 群组内发送者白名单（仅列表中的成员消息会被处理） */
    allowFrom?: Array<string | number>;
}
/**
 * 企业微信配置类型
 */
export interface WeComConfig {
    enabled?: boolean;
    websocketUrl?: string;
    botId?: string;
    secret?: string;
    name?: string;
    allowFrom?: Array<string | number>;
    dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
    /** 群组访问策略："open" = 允许所有群组（默认），"allowlist" = 仅允许 groupAllowFrom 中的群组，"disabled" = 禁用群组消息 */
    groupPolicy?: "open" | "allowlist" | "disabled";
    /** 群组白名单（仅 groupPolicy="allowlist" 时生效） */
    groupAllowFrom?: Array<string | number>;
    /** 每个群组的详细配置（如群组内发送者白名单） */
    groups?: Record<string, WeComGroupConfig>;
    /** 是否发送"思考中"消息，默认为 true */
    sendThinkingMessage?: boolean;
}
export declare const DefaultWsUrl = "wss://openws.work.weixin.qq.com";
export interface ResolvedWeComAccount {
    accountId: string;
    name: string;
    enabled: boolean;
    websocketUrl: string;
    botId: string;
    secret: string;
    /** 是否发送"思考中"消息，默认为 true */
    sendThinkingMessage: boolean;
    config: WeComConfig;
}
/**
 * 解析企业微信账户配置
 */
export declare function resolveWeComAccount(cfg: OpenClawConfig): ResolvedWeComAccount;
/**
 * 设置企业微信账户配置
 */
export declare function setWeComAccount(cfg: OpenClawConfig, account: Partial<WeComConfig>): OpenClawConfig;
