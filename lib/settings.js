// settings.js — 运行时可变设置（热生效 + 酒馆 extension settings 持久化）。
// 1:1 移植自 V.Adapter（Go）settings.go：
//   - Go 版写到 data/settings.json，扩展版写到酒馆的 extension_settings.v_adapter
//     （随酒馆设置文件持久化，重启不丢失）；
//   - 归一化规则、脱敏规则、字段语义与 Go 版完全一致；
//   - Go 版的 listen 字段在扩展形态无意义（没有独立端口），字段保留、界面照常显示，
//     保存规则照旧但不再需要重启。

import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

const MODULE_KEY = 'v_adapter';

// persistedSettings 与 Go 版 settings.json 的字段一一对应。
const FIELDS = [
    'qwen_url', 'qwen_key', 'qwen_model', 'default_size',
    'nai_key', 'chat_fallback', 'listen',
];

export function defaultSettings() {
    return {
        qwen_url: 'http://127.0.0.1:4000/v1',
        qwen_key: 'sk-你的上游密钥',
        qwen_model: 'qwen3.8-max',
        default_size: '1024x1024',
        nai_key: 'v-adapter-8888',
        chat_fallback: 'auto',
        listen: '0.0.0.0:8888', // 扩展形态仅保留字段（无独立端口）
    };
}

// ── 运行期内存快照（热生效读取点直接读这里）──
let rt = defaultSettings();

// initSettings 启动初始化：默认值 → 酒馆持久化覆盖存在的字段。
export function initSettings() {
    const saved = extension_settings[MODULE_KEY] ?? {};
    rt = defaultSettings();
    for (const k of FIELDS) {
        if (saved[k] !== undefined && saved[k] !== null) rt[k] = saved[k];
    }
    rt.qwen_url = String(rt.qwen_url).trim();
    rt.qwen_key = String(rt.qwen_key).trim();
    rt.qwen_model = String(rt.qwen_model).trim();
    rt.default_size = normalizeSizeOrDefault(rt.default_size);
    rt.nai_key = String(rt.nai_key).trim();
    rt.chat_fallback = normalizeChatFallback(rt.chat_fallback);
}

function persist() {
    extension_settings[MODULE_KEY] = JSON.parse(JSON.stringify(rt));
    saveSettingsDebounced();
}

// ── 归一化工具（与 Go 版一致）──

// normalizeSizeStr 校验「宽x高」字符串（也容忍 × 与空格），返回规范形式。
export function normalizeSizeStr(s) {
    s = String(s ?? '').toLowerCase().trim().replaceAll('×', 'x');
    const parts = s.split('x');
    if (parts.length !== 2) return null;
    const w = parseInt(parts[0].trim(), 10);
    const h = parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 4096 || h > 4096) return null;
    return `${w}x${h}`;
}

export function normalizeSizeOrDefault(s) {
    return normalizeSizeStr(s) ?? '1024x1024';
}

export function normalizeChatFallback(s) {
    switch (String(s ?? '').toLowerCase().trim()) {
        case 'off': return 'off';
        case 'chat_only': return 'chat_only';
        case 'openai': return 'openai';
        default: return 'auto';
    }
}

// maskKey Key 脱敏：短 key 只留首字符（如 1 → 1***），长 key 留头 3 尾 2。
export function maskKey(k) {
    k = String(k ?? '').trim();
    if (!k) return '';
    const r = [...k];
    if (r.length <= 4) return r[0] + '***';
    return r.slice(0, 3).join('') + '***' + r.slice(-2).join('');
}

// ── 线程安全 getter（热生效读取点统一走这里）──
export const settingsGet = {
    qwenURL: () => rt.qwen_url,
    qwenKey: () => rt.qwen_key,
    qwenModel: () => rt.qwen_model,
    defaultSize: () => rt.default_size,
    naiKey: () => rt.nai_key,
    chatFallback: () => rt.chat_fallback,
    listen: () => rt.listen,
};

// settingsView 设置中心展示快照。Key 一律脱敏（GET /admin/settings
// 不返回明文 key），只给 *_set 布尔让前端知道是否已配置。
export function settingsView() {
    return {
        qwen_url: rt.qwen_url,
        qwen_key_masked: maskKey(rt.qwen_key),
        qwen_key_set: rt.qwen_key !== '',
        qwen_model: rt.qwen_model,
        default_size: rt.default_size,
        nai_key_masked: maskKey(rt.nai_key),
        nai_key_required: rt.nai_key !== '',
        chat_fallback: rt.chat_fallback,
        listen: rt.listen,
    };
}

// applySettings 应用面板提交的键值：校验并热生效，返回 (changed, notes)。
//
// Key 字段特殊语义（面板明文不留存）：
//   - 提交为空 / 与当前脱敏值相同 → 视为「未修改」，跳过；
//   - 真正清空用 body 里的 "clear": ["qwen_key"|"nai_key"]。
export function applySettings(body) {
    const changed = [], notes = [];
    const toStr = v => (typeof v === 'string' ? v : '');

    if ('qwen_url' in body) {
        const s = toStr(body.qwen_url).trim();
        if (s && s !== rt.qwen_url) { rt.qwen_url = s; changed.push('qwen_url'); resetImagesBrokenCompat(); }
    }
    if ('qwen_key' in body) {
        const s = toStr(body.qwen_key).trim();
        if (s && s !== maskKey(rt.qwen_key)) { rt.qwen_key = s; changed.push('qwen_key'); resetImagesBrokenCompat(); }
    }
    if ('qwen_model' in body) {
        const s = toStr(body.qwen_model).trim();
        if (s && s !== rt.qwen_model) { rt.qwen_model = s; changed.push('qwen_model'); resetImagesBrokenCompat(); }
    }
    if ('default_size' in body) {
        const s = toStr(body.default_size).trim();
        if (!s) { /* 空值不动 */ }
        else {
            const n = normalizeSizeStr(s);
            if (n) { if (n !== rt.default_size) { rt.default_size = n; changed.push('default_size'); } }
            else notes.push('default_size 格式无效（应为 宽x高，如 832x1216），已忽略');
        }
    }
    if ('nai_key' in body) {
        const s = toStr(body.nai_key).trim();
        if (s && s !== maskKey(rt.nai_key)) { rt.nai_key = s; changed.push('nai_key'); }
    }
    if ('chat_fallback' in body) {
        const s = normalizeChatFallback(toStr(body.chat_fallback));
        if (s !== rt.chat_fallback) { rt.chat_fallback = s; changed.push('chat_fallback'); }
    }
    if ('listen' in body) {
        const s = toStr(body.listen).trim();
        if (s && s !== rt.listen) {
            rt.listen = s;
            changed.push('listen');
            notes.push('listen 已保存（扩展内置模式实际不使用独立端口）');
        }
    }
    if (Array.isArray(body.clear)) {
        for (const c of body.clear) {
            if (c === 'qwen_key') {
                if (rt.qwen_key !== '') { rt.qwen_key = ''; changed.push('qwen_key'); }
            } else if (c === 'nai_key') {
                if (rt.nai_key !== '') {
                    rt.nai_key = '';
                    changed.push('nai_key');
                    notes.push('nai_key 已清空：客户端填任意 key 均可调用');
                }
            }
        }
    }

    if (changed.length > 0) persist();
    return [changed, notes];
}

// resetImagesBrokenCompat 换上游后清除熔断（pipeline.js 启动时注入）。
let _resetImagesBroken = () => {};
export function bindResetImagesBroken(fn) { _resetImagesBroken = fn; }
function resetImagesBrokenCompat() { _resetImagesBroken(); }
