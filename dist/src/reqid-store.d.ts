/** Store 配置 */
interface ReqIdStoreOptions {
    /** TTL 毫秒数，超时的 reqId 视为过期（默认 24 小时） */
    ttlMs?: number;
    /** 内存最大条目数（默认 200） */
    memoryMaxSize?: number;
    /** 磁盘最大条目数（默认 500） */
    fileMaxEntries?: number;
    /** 磁盘写入防抖时间（毫秒），默认 1000ms */
    flushDebounceMs?: number;
}
export interface PersistentReqIdStore {
    /** 设置 chatId 对应的 reqId（写入内存 + 防抖写磁盘） */
    set(chatId: string, reqId: string): void;
    /** 获取 chatId 对应的 reqId（异步：优先内存，miss 时查磁盘并回填内存） */
    get(chatId: string): Promise<string | undefined>;
    /** 同步获取 chatId 对应的 reqId（仅内存） */
    getSync(chatId: string): string | undefined;
    /** 删除 chatId 对应的 reqId */
    delete(chatId: string): void;
    /** 启动时从磁盘预热内存，返回加载条目数 */
    warmup(onError?: (error: unknown) => void): Promise<number>;
    /** 立即将内存数据刷写到磁盘（用于优雅退出） */
    flush(): Promise<void>;
    /** 清空内存缓存 */
    clearMemory(): void;
    /** 返回内存中的条目数 */
    memorySize(): number;
}
export declare function createPersistentReqIdStore(accountId: string, options?: ReqIdStoreOptions): PersistentReqIdStore;
export {};
