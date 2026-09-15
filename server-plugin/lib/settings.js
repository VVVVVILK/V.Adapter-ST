// settings.js — 运行时可变设置（Node 服务端版）。
// 1:1 移植自 V.Adapter（Go）settings.go：
//   - 启动默认值 config.json（本插件用 data/config.json）+ 环境变量覆盖，
//     再被 data/settings.json 覆盖（面板改动最高优先级，热生效）；
//   - 归一化规则、脱敏规则、字段语义与 Go 版完全一致。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// VADAPTER_DATA_DIR 由服务端引导器注入，使运行数据与代码所在位置解耦：
// 代码可随扩展更新到任意目录，配置始终落在该环境变量指向的位置。
const dataDir = process.env.VADAPTER_DATA_DIR
    ? path.resolve(process.env.VADAPTER_DATA_DIR)
    : path.join(pluginDir, 'data');
const settingsPath = path.join(dataDir, 'settings.json');
const configPath = path.join(dataDir, 'config.json');

// 与 Go 版 startupConfig 字段一一对应。
const DEFAULTS = {
    listen: '0.0.0.0:8888',
    qwen_url: 'http://127.0.0.1:4000/v1',
    qwen_key: 'sk-你的上游密钥',
    qwen_model: 'qwen3.8-max',
    default_size: '1024x1024',
    nai_key: 'v-adapter-8888',
    chat_fallback: 'auto',
};

let rt = { ...DEFAULTS };

function readJSON(p) {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// initSettings 启动初始化：默认 → data/config.json → 环境变量 → data/settings.json。
export function initSettings() {
    rt = { ...DEFAULTS };

    const cfg = readJSON(configPath);
    if (cfg && typeof cfg === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (cfg[k] !== undefined && cfg[k] !== null) rt[k] = cfg[k];
        }
    }

    const env = process.env;
    const envMap = [
        ['qwen_url', ['VADAPTER_QWEN_URL', 'OPENAI_BASE_URL']],
        ['qwen_key', ['VADAPTER_QWEN_KEY', 'OPENAI_API_KEY']],
        ['qwen_model', ['VADAPTER_QWEN_MODEL', 'OPENAI_IMAGE_MODEL']],
        ['listen', ['VADAPTER_LISTEN']],
        ['default_size', ['VADAPTER_DEFAULT_SIZE']],
        ['nai_key', ['VADAPTER_NAI_KEY']],
    ];
    for (const [field, names] of envMap) {
        for (const n of names) {
            const v = String(env[n] ?? '').trim();
            if (v) { rt[field] = v; break; }
        }
    }

    const saved = readJSON(settingsPath);
    if (saved && typeof saved === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (saved[k] !== undefined && saved[k] !== null) rt[k] = saved[k];
        }
    }

    // 归一化
    rt.qwen_url = String(rt.qwen_url).trim();
    rt.qwen_key = String(rt.qwen_key).trim();
    rt.qwen_model = String(rt.qwen_model).trim();
    rt.default_size = normalizeSizeOrDefault(rt.default_size);
    rt.nai_key = String(rt.nai_key).trim();
    rt.chat_fallback = normalizeChatFallback(rt.chat_fallback);
    rt.listen = normalizeListenOrDefault(rt.listen);
}

// ── 归一化工具（与 Go 版一致）──

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

export function normalizeListen(s) {
    s = String(s ?? '').trim();
    if (!s) return null;
    if (!s.includes(':')) s = ':' + s;
    const idx = s.lastIndexOf(':');
    const port = parseInt(s.slice(idx + 1), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return s;
}

export function normalizeListenOrDefault(s) {
    return normalizeListen(s) ?? '0.0.0.0:8888';
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

// ── getter ──
export const settingsGet = {
    qwenURL: () => rt.qwen_url,
    qwenKey: () => rt.qwen_key,
    qwenModel: () => rt.qwen_model,
    defaultSize: () => rt.default_size,
    naiKey: () => rt.nai_key,
    chatFallback: () => rt.chat_fallback,
    listen: () => rt.listen,
};

// settingsView 设置中心展示快照（Key 一律脱敏）。
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

function persist() {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(rt, null, 2), 'utf8');
    } catch (e) {
        console.log(`[V.Adapter] 写入设置失败: ${e.message}`);
    }
}

// applySettings 应用面板提交的键值：校验并热生效，返回 [changed, notes]。
export function applySettings(body) {
    const changed = [], notes = [];
    const toStr = v => (typeof v === 'string' ? v : '');

    if ('qwen_url' in body) {
        const s = toStr(body.qwen_url).trim();
        if (s && s !== rt.qwen_url) { rt.qwen_url = s; changed.push('qwen_url'); resetImagesBroken(); }
    }
    if ('qwen_key' in body) {
        const s = toStr(body.qwen_key).trim();
        if (s && s !== maskKey(rt.qwen_key)) { rt.qwen_key = s; changed.push('qwen_key'); resetImagesBroken(); }
    }
    if ('qwen_model' in body) {
        const s = toStr(body.qwen_model).trim();
        if (s && s !== rt.qwen_model) { rt.qwen_model = s; changed.push('qwen_model'); resetImagesBroken(); }
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
        const s = normalizeListen(toStr(body.listen));
        if (s && s !== rt.listen) {
            rt.listen = s;
            changed.push('listen');
            notes.push('listen 已保存，重启酒馆后生效');
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

// 熔断重置钩子（server.js 启动时注入，避免循环依赖）
let _resetImagesBroken = () => {};
export function bindResetImagesBroken(fn) { _resetImagesBroken = fn; }
function resetImagesBroken() { try { _resetImagesBroken(); } catch { /* ignore */ } }
