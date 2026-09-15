// genlog.js — 生成记录环形缓冲（内存，最近 200 条），供面板运行总览与记录页展示。
// 1:1 移植自 V.Adapter（Go）genlog.go。

const GEN_LOG_CAP = 200;

class GenLogStore {
    constructor() {
        this.records = [];
        this.success = 0;
        this.fail = 0;
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
    }
}

export const genLog = new GenLogStore();
export const genLogCap = GEN_LOG_CAP;

// GenRecord 构造器（字段与 Go 版 GenRecord json 标签一致，面板直接消费）。
export function newRecord(fields) {
    return Object.assign({
        time: '', kind: '', endpoint: '', model: '', prompt: '',
        size: '', via: '', ok: false, status: 0, latency_ms: 0, error: undefined,
    }, fields);
}
