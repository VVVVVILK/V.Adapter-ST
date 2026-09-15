// admin.js — 管理面板端点（运行总览 / 设置中心 / 测试连接 / 画风预设 / 角色转译 / 生成记录）
//             + 面板登录（首次免密、可设密码）。
// 1:1 移植自 V.Adapter（Go）的 admin.go + auth.go + settings.go 里的 handleAdminSettings。
//
// 路由一览（前 5 个需面板登录；未设密码时全部放行，由面板引导设置）：
//   GET    /admin/status            运行状态 + 脱敏配置 + 最近记录（**公开**，与 /health 同级）
//   GET    /admin/settings          读设置（Key 脱敏）
//   POST   /admin/settings          写设置（热生效并落盘 data/settings.json）
//   POST   /admin/test              实调一次上游生图，返回预览图
//   POST   /admin/translate         角色转译（可选顺带出图）
//   GET    /admin/logs?limit=N      生成记录   /  DELETE /admin/logs  清空
//   GET    /admin/auth/status       登录态（公开，登录遮罩用）
//   POST   /admin/auth/login        登录          /admin/auth/setup  设置/修改/关闭密码
//   POST   /admin/auth/logout       退出

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { settingsGet, settingsView, applySettings, normalizeSizeStr } from './settings.js';
import { genLog, genLogCap, newRecord } from './genlog.js';
import { targetFromSettings, generateImage, truncate, mimeForExt, bytesToBase64 } from './pipeline.js';
import { translateCharacter, mergeNegative, translateDefaultNegative } from './translate.js';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // plugins/V.Adapter
const dataDir = path.join(pluginDir, 'data');
const authPath = path.join(dataDir, 'auth.json');

// ── 运行期信息（server.js 启动时注入，避免循环依赖）──
let runtime = { version: '-', startedAt: new Date() };
export function setRuntime(info) {
    runtime = { ...runtime, ...info };
}

// ── 响应小工具 ──

// writeJSON 统一 JSON 输出（NovelAI 端点错误用 {"message": …}，面板端点用 {success,error}）。
export function writeJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function writeAdminErr(res, code, msg) {
    writeJSON(res, code, { success: false, error: msg });
}

// readJsonBody 读请求体并解析 JSON（空体返回 null）。
function readJsonBody(req, maxBytes = 8 << 20) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text.trim()) return resolve(null);
            try {
                resolve(JSON.parse(text));
            } catch (e) {
                reject(new Error('请求体不是合法 JSON：' + e.message));
            }
        });
        req.on('error', reject);
    });
}

function toStr(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return '';
    return String(v);
}

// ── 面板登录（对应 auth.go）──

const PANEL_COOKIE = 'v_adapter_panel';
const PANEL_TTL_MS = 24 * 60 * 60 * 1000;

let authHash = '';                  // 空 = 未设置密码（/admin/* 全部放行）
const sessions = new Map();         // token -> 过期时间戳(ms)

function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex');
}

function readCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// initAuth 启动时加载面板密码（在路由接管前调用）。
export function initAuth() {
    try {
        if (fs.existsSync(authPath)) {
            const d = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            authHash = toStr(d?.password_hash).trim();
        } else {
            authHash = '';
        }
    } catch (e) {
        authHash = '';
        console.log(`[V.Adapter] 读取面板密码失败（按未设置处理）: ${e.message}`);
    }
}

function saveAuthHash(h) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ password_hash: h }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function panelPasswordSet() {
    return authHash !== '';
}

function panelOK(req) {
    if (!panelPasswordSet()) return true;
    const token = readCookies(req)[PANEL_COOKIE];
    if (!token) return false;
    const expiry = sessions.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function newSessionToken() {
    return crypto.randomBytes(24).toString('hex');
}

function setPanelCookie(res, token) {
    const parts = [
        `${PANEL_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(PANEL_TTL_MS / 1000)}`,
    ];
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearPanelCookie(res) {
    res.setHeader('Set-Cookie', `${PANEL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── 各端点 ──

// GET /admin/auth/status → {success, setup_required, locked}（公开）
function handleAuthStatus(req, res) {
    const set = panelPasswordSet();
    writeJSON(res, 200, {
        success: true,
        setup_required: !set,
        locked: set && !panelOK(req),
    });
}

// POST /admin/auth/login {password}
async function handleAuthLogin(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!panelPasswordSet()) {
        writeAdminErr(res, 400, '尚未设置面板密码，请先完成首次设置');
        return;
    }
    if (hashPassword(toStr(body?.password)) !== authHash) {
        writeAdminErr(res, 401, '密码错误');
        return;
    }
    const token = newSessionToken();
    sessions.set(token, Date.now() + PANEL_TTL_MS);
    setPanelCookie(res, token);
    writeJSON(res, 200, { success: true });
}

// POST /admin/auth/setup {password} → 设置/修改/关闭面板密码（password 为空 = 关闭）
async function handleAuthSetup(req, res) {
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    const password = toStr(body?.password).trim();
    const set = panelPasswordSet();

    if (set && !panelOK(req)) {
        writeAdminErr(res, 401, '请先登录后再修改面板密码');
        return;
    }
    if (password === '') {
        if (!set) {
            writeAdminErr(res, 400, '密码不能为空');
            return;
        }
        try {
            saveAuthHash('');
        } catch (e) {
            writeAdminErr(res, 500, '保存失败: ' + e.message);
            return;
        }
        authHash = '';
        writeJSON(res, 200, { success: true, closed: true });
        return;
    }
    if (password.length < 4) {
        writeAdminErr(res, 400, '密码至少 4 位');
        return;
    }
    const hash = hashPassword(password);
    try {
        saveAuthHash(hash);
    } catch (e) {
        writeAdminErr(res, 500, '保存失败: ' + e.message);
        return;
    }
    authHash = hash;
    if (!set) {
        // 首次设置成功即视为已登录（不用再输一次）
        const token = newSessionToken();
        sessions.set(token, Date.now() + PANEL_TTL_MS);
        setPanelCookie(res, token);
    }
    writeJSON(res, 200, { success: true });
}

// POST /admin/auth/logout
function handleAuthLogout(req, res) {
    const token = readCookies(req)[PANEL_COOKIE];
    if (token) sessions.delete(token);
    clearPanelCookie(res);
    writeJSON(res, 200, { success: true });
}

// GET /admin/status（公开）
function handleAdminStatus(req, res) {
    const [success, fail] = genLog.Counters();
    writeJSON(res, 200, {
        status: 'ok',
        version: runtime.version,
        started_at: formatTime(runtime.startedAt),
        uptime_seconds: Math.floor((Date.now() - runtime.startedAt.getTime()) / 1000),
        listen: settingsGet.listen(),
        settings: settingsView(),
        counters: { success, fail, total: success + fail },
        recent: genLog.Snapshot(10),
    });
}

// GET/POST /admin/settings
async function handleAdminSettings(req, res) {
    if (req.method === 'GET') {
        writeJSON(res, 200, { success: true, settings: settingsView() });
        return;
    }
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, '方法不支持');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') body = {};
    if (body.settings && typeof body.settings === 'object') body = body.settings;

    const [changed, notes] = applySettings(body);
    for (const k of changed) {
        if (k === 'nai_key' && settingsGet.naiKey() !== '') console.log('[V.Adapter] [Settings] nai_key 已更新（客户端须同步改 Key）');
        if (k === 'qwen_key') console.log('[V.Adapter] [Settings] qwen_key 已更新');
    }
    writeJSON(res, 200, { success: true, changed, notes, settings: settingsView() });
}

// POST /admin/test → 实调一次上游生图（body 可覆盖 url/key/model/size/prompt，不落盘）
async function handleAdminTest(req, res) {
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, '方法不支持');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') body = {};

    const tgt = targetFromSettings();
    if (toStr(body.url).trim()) tgt.url = toStr(body.url).trim();
    if (toStr(body.key).trim()) tgt.key = toStr(body.key).trim();
    if (toStr(body.model).trim()) tgt.model = toStr(body.model).trim();
    const size = normalizeSizeStr(toStr(body.size)) ?? settingsGet.defaultSize();
    let prompt = toStr(body.prompt).trim();
    if (!prompt) prompt = '一只红色的苹果放在木桌上，柔和光线，静物摄影，测试图';

    const start = Date.now();
    let img = null;
    let err = null;
    try {
        img = await generateImage(tgt, prompt, '', size, settingsGet.chatFallback());
    } catch (e) {
        err = e;
    }
    const latency = Date.now() - start;

    const rec = newRecord({
        kind: 'test', endpoint: '/admin/test', model: tgt.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (err) {
        rec.status = 502;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        console.log(`[V.Adapter] [Test] 测试连接失败（${latency}ms）：${err.message}`);
        writeAdminErr(res, 502, truncate(err.message, 500));
        return;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    const bytes = img.data ? img.data.length : 0;
    console.log(`[V.Adapter] [Test] 测试连接成功（${latency}ms via ${img.via}）：${size} ${img.ext} ${Math.floor(bytes / 1024)}KB`);

    writeJSON(res, 200, {
        success: true,
        latency_ms: latency,
        model: tgt.model,
        size,
        via: img.via,
        ext: img.ext,
        bytes,
        preview: previewOf(img),
        message: `生成成功：耗时 ${latency}ms，链路 ${img.via}`,
    });
}

// GET /admin/logs?limit=N   /   DELETE /admin/logs
function handleAdminLogs(req, res, url) {
    if (req.method === 'GET') {
        let limit = 100;
        const q = parseInt(url.searchParams.get('limit') ?? '', 10);
        if (Number.isFinite(q) && q > 0) limit = q;
        const [success, fail] = genLog.Counters();
        writeJSON(res, 200, {
            success: true,
            logs: genLog.Snapshot(limit),
            cap: genLogCap,
            counters: { success, fail, total: success + fail },
        });
        return;
    }
    if (req.method === 'DELETE') {
        genLog.Clear();
        writeJSON(res, 200, { success: true });
        return;
    }
    writeAdminErr(res, 405, '方法不支持');
}

// POST /admin/translate → 角色转译（可选顺带出图）
async function handleAdminTranslate(req, res) {
    if (req.method !== 'POST') {
        writeAdminErr(res, 405, '方法不支持');
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (e) {
        writeAdminErr(res, 400, e.message);
        return;
    }
    if (!body || typeof body !== 'object') {
        writeAdminErr(res, 400, '请求体解析失败');
        return;
    }

    const wantGenerate = !!body.generate;
    const reqSize = toStr(body.size);

    let result;
    const givenPrompt = toStr(body.prompt).trim();
    if (givenPrompt) {
        // 「再出一张」：沿用上一次的提示词，不再走转译
        let neg = toStr(body.negative).trim();
        if (!neg) neg = mergeNegative(translateDefaultNegative);
        const [dw, dh] = defaultSizeWH();
        result = {
            prompt: givenPrompt, character_prompt: '', main_prompt: '',
            negative_prompt: neg, width: dw, height: dh, steps: 28, cfg_scale: 7.0,
        };
    } else {
        try {
            result = await translateCharacter(targetFromSettings(), toStr(body.text));
        } catch (e) {
            console.log(`[V.Adapter] [Translate] 转译失败：${e.message}`);
            writeAdminErr(res, 502, truncate(e.message, 300));
            return;
        }
        console.log(`[V.Adapter] [Translate] 转译成功：${truncate(toStr(body.text).trim(), 40)} → 总提示词 ${[...result.prompt].length} 字`);
    }

    const out = { success: true, data: result };
    if (!wantGenerate) {
        writeJSON(res, 200, out);
        return;
    }

    const tgt = targetFromSettings();
    let prompt = toStr(result.prompt).trim();
    if (!prompt) prompt = `${toStr(result.character_prompt).trim()}，${toStr(result.main_prompt).trim()}`;
    let neg = toStr(result.negative_prompt);
    let size = `${result.width}x${result.height}`;
    const norm = normalizeSizeStr(reqSize);
    if (norm) size = norm;

    const start = Date.now();
    let img = null;
    let gerr = null;
    try {
        img = await generateImage(tgt, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    const latency = Date.now() - start;

    out.latency_ms = latency;
    out.used_size = size;
    out.used_prompt = prompt;

    const rec = newRecord({
        kind: 'translate', endpoint: '/admin/translate', model: tgt.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (gerr) {
        rec.status = 502;
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        console.log(`[V.Adapter] [Translate] 出图失败（${latency}ms）：${gerr.message}`);
        // 转译成功但出图失败：仍是 200，错误放 image_error（避免抹掉已拿到的提示词）
        out.image_error = truncate(gerr.message, 500);
        writeJSON(res, 200, out);
        return;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    const bytes = img.data ? img.data.length : 0;
    console.log(`[V.Adapter] [Translate] 出图成功（${latency}ms via ${img.via}）：${size} ${img.ext} ${Math.floor(bytes / 1024)}KB`);

    out.preview = previewOf(img);
    out.via = img.via;
    out.ext = img.ext;
    out.bytes = bytes;
    out.used_negative = neg;
    writeJSON(res, 200, out);
}

// ── 小工具 ──

// previewOf 面板预览：有字节就用 data URL；只有远程链接（跨域降级）就直接给链接。
function previewOf(img) {
    if (img.data && img.data.length) {
        return `data:${mimeForExt(img.ext)};base64,${bytesToBase64(img.data)}`;
    }
    return img.remoteUrl ?? '';
}

// defaultSizeWH 解析默认尺寸，兜底 1024x1024（对应 Go 版 defaultSizeWH）。
function defaultSizeWH() {
    const s = normalizeSizeStr(settingsGet.defaultSize()) ?? '1024x1024';
    const [w, h] = s.split('x').map(v => parseInt(v, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [1024, 1024];
    return [w, h];
}

function formatTime(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── 总入口 ──

/**
 * handleAdminRequest 处理 /admin/* 请求。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handleAdminRequest(req, res, url) {
    const p = normalizePath(url.pathname);

    // 公开端点
    if (p === '/admin/status') return handleAdminStatus(req, res), true;
    if (p === '/admin/auth/status') return handleAuthStatus(req, res), true;

    // 登录相关（自行判断登录态）
    if (p === '/admin/auth/login') { await handleAuthLogin(req, res); return true; }
    if (p === '/admin/auth/setup') { await handleAuthSetup(req, res); return true; }
    if (p === '/admin/auth/logout') return handleAuthLogout(req, res), true;

    // 其余需要面板登录（未设密码时放行）
    const routes = {
        '/admin/settings': handleAdminSettings,
        '/admin/test': handleAdminTest,
        '/admin/translate': handleAdminTranslate,
        '/admin/logs': (rq, rs) => handleAdminLogs(rq, rs, url),
    };
    const handler = routes[p];
    if (!handler) return false;

    if (!panelOK(req)) {
        writeAdminErr(res, 401, '面板已锁定：请先登录');
        return true;
    }
    await handler(req, res);
    return true;
}

function normalizePath(p) {
    const s = String(p ?? '/');
    const t = s.replace(/\/+$/, '');
    return t === '' ? '/' : t;
}
