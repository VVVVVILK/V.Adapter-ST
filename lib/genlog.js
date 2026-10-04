// genlog.js — 生成记录环形缓冲（最近 200 条），供面板运行总览与记录页展示。
// 1:1 移植自 V.Adapter（Go）genlog.go，在扩展形态下额外支持持久化：
// 经 bindStorage() 挂上存取器后，新增/清空都会写回酒馆的 extension settings，
// 重启酒馆、刷新页面后记录仍在（服务端插件形态不挂存取器，行为与 Go 版一致，纯内存）。

const GEN_LOG_CAP = 200;

class GenLogStore {
    constructor() {
        this.records = [];
        this.success = 0;
        this.fail = 0;
        this._persist = null;
    }

    // bindStorage 挂载持久化存取器：{ load(): Array|null, save(records): void }。
    // load 返回的条目做一次形状过滤与截断，计数器按恢复出的记录重算。
    bindStorage(adapter) {
        this._persist = adapter ?? null;
        const saved = adapter && typeof adapter.load === 'function' ? adapter.load() : null;
        if (!Array.isArray(saved)) return;
        const restored = saved
            .filter(r => r && typeof r === 'object' && typeof r.time === 'string')
            .slice(-GEN_LOG_CAP);
        if (!restored.length) return;
        this.records = restored;
        this.success = restored.filter(r => r.ok).length;
        this.fail = restored.length - this.success;
    }

    _scheduleSave() {
        if (!this._persist) return;
        try { this._persist.save(this.records.slice(-GEN_LOG_CAP)); } catch { /* 持久化失败不影响使用 */ }
    }

    Add(r) {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        r.time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        if (r.ok) this.success++; else this.fail++;
        this.records.push(r);
        if (this.records.length > GEN_LOG_CAP) {
            this.records = this.records.slice(this.records.length - GEN_LOG_CAP);
        }
        this._scheduleSave();
    }

    // 最新在前的前 limit 条。
    Snapshot(limit) {
        const n = this.records.length;
        if (!limit || limit <= 0 || limit > n) limit = n;
        const out = [];
        for (let i = n - 1; i >= n - limit; i--) out.push(this.records[i]);
        return out;
    }

    Counters() {
        return [this.success, this.fail];
    }

    Clear() {
        this.records = [];
        this.success = 0;
        this.fail = 0;
        this._scheduleSave();
    }
}

export const genLog = new GenLogStore();
export const genLogCap = GEN_LOG_CAP;

// GenRecord 构造器（字段与 Go 版 GenRecord json 标签一致，面板直接消费）。
// url 为本次结果的稳定引用（本地落盘文件优先；CORS 降级时是远程临时链接）。
export function newRecord(fields) {
    return Object.assign({
        time: '', kind: '', endpoint: '', model: '', prompt: '',
        size: '', via: '', url: '', ok: false, status: 0, latency_ms: 0, error: undefined,
    }, fields);
}
