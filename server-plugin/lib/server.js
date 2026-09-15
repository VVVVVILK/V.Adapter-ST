// server.js — 内嵌 HTTP 服务（组装路由 + CORS）。
//
// 对应 Go 版 main.go 的 main()：把 NAI 协议端点、管理面板端点、内嵌单文件面板
// 组装到一个**独立监听端口**（默认 8888，可在面板改，重启生效）上。
//
// 采用独立监听端口而非酒馆自身路由的原因：酒馆服务端存在 CSRF 防护，第三方客户端
// 直接请求酒馆的插件路由会被拦截 403。插件自开端口可规避该限制，同时**保留原版的对接方式**
// （客户端 NovelAI 渠道 URL 仍填 IP:8888，无需修改）。
//
// 路由一览：
//   POST /ai/generate-image     NAI 生图 → ZIP（需 nai_key）
//   GET  /ai/user/subscription  测试连接（需 nai_key）
//   POST /ai/encode-vibe        不支持 → 404
//   GET  /admin/*               管理面板端点（见 admin.js）
//   GET  /health                健康检查
//   GET  /                      内嵌管理面板（panel.html）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSettings, settingsGet, bindResetImagesBroken } from './settings.js';
import { handleGenerateImage, handleSubscription, handleEncodeVibe, naiKeyGate } from './nai.js';
import { resetImagesBroken, logf } from './pipeline.js';
import { initAuth, handleAdminRequest, setRuntime, writeJSON } from './admin.js';

export const version = 'v1.1.5-st.1';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // plugins/V.Adapter
const panelPath = path.join(pluginDir, 'panel.html');

const startedAt = new Date();
let server = null;
let boundListen = '';
let started = false;

// ── 请求上下文（nai.js 的处理器按 (req, res, ctx) 调用）──

// readBody 读满请求体（上限 maxBytes），返回 Buffer。
function readBody(req, maxBytes = 32 << 20) {
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
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// ctxFor 按请求构造处理器上下文（nai.js 里调用的是 ctx.readBody(上限)，不传 req）——
// 所以 readBody 必须预先绑定当前请求。
function ctxFor(req) {
    return {
        readBody: (maxBytes) => readBody(req, maxBytes),
        logf,
    };
}

// ── 内嵌面板：注入 API 桥接 ──

let panelHTMLCache = null;

// panel.html 原本是给「扩展版」用的，它通过 window.parent.__V_ADAPTER_API__ 发请求。
// 服务端形态下面板是直接打开的（window.parent === window），所以在返回的 HTML 里
// 先注入一个同名桥接（改走真正的 HTTP），**panel.html 本身一行都不用动**。
const API_SHIM = `<script>
window.__V_ADAPTER_API__ = (function () {
    return async function (path, method, body) {
        var opts = { method: method || 'GET', headers: { 'Accept': 'application/json' }, credentials: 'same-origin' };
        if (method && method !== 'GET' && method !== 'HEAD' && body !== null && body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        try {
            var r = await fetch(path, opts);
            var data = null;
            try { data = await r.json(); } catch (e) { data = null; }
            return { ok: r.ok, status: r.status, data: data };
        } catch (e) {
            return { ok: false, status: 0, data: { success: false, error: '连接本地服务失败：' + e.message } };
        }
    };
})();
</script>`;

function loadPanel() {
    if (panelHTMLCache !== null) return panelHTMLCache;
    try {
        let html = fs.readFileSync(panelPath, 'utf8');
        const headRe = /<head[^>]*>/i;
        if (headRe.test(html)) {
            html = html.replace(headRe, m => m + '\n' + API_SHIM);
        } else {
            html = API_SHIM + '\n' + html;
        }
        panelHTMLCache = html;
    } catch (e) {
        panelHTMLCache = `<pre>管理面板读取失败：${e.message}\n期望文件：${panelPath}</pre>`;
    }
    return panelHTMLCache;
}

// ── 路由 ──

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    // 浏览器端（V.Canvas 面板等）需要读取这几个头才能拿到实际送入上游的提示词与链路信息。
    res.setHeader('Access-Control-Expose-Headers', 'X-Illust-Via, X-Illust-Prompt, X-Illust-Expand');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function normalizePath(p) {
    const s = String(p ?? '/');
    const t = s.replace(/\/+$/, '');
    return t === '' ? '/' : t;
}

async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = normalizePath(url.pathname);
    const ctx = ctxFor(req);

    if (p === '/health') {
        writeJSON(res, 200, { status: 'ok', version });
        return;
    }

    // ── NovelAI 协议端点（客户端调用）──
    if (p === '/ai/generate-image') {
        await naiKeyGate(handleGenerateImage)(req, res, ctx);
        return;
    }
    if (p === '/ai/user/subscription') {
        await naiKeyGate(handleSubscription)(req, res, ctx);
        return;
    }
    if (p === '/ai/encode-vibe') {
        handleEncodeVibe(req, res, ctx);
        return;
    }

    // ── 管理面板端点 ──
    if (p === '/admin' || p.startsWith('/admin/')) {
        const handled = await handleAdminRequest(req, res, url);
        if (!handled) writeJSON(res, 404, { success: false, error: `未找到端点：${p}` });
        return;
    }

    // ── 内嵌面板 ──
    if (p === '/') {
        const html = loadPanel();
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
    }

    writeJSON(res, 404, { message: `未找到端点：${p}` });
}

// ── 启动 / 停止 ──

/**
 * startAdapterService 启动内嵌适配服务（酒馆 server plugin 的 init 调用）。
 * 端口来自 settings 的 listen（默认 0.0.0.0:8888）。
 */
export async function startAdapterService() {
    if (started) return { listen: boundListen };

    initSettings();
    initAuth();
    bindResetImagesBroken(resetImagesBroken);
    setRuntime({ version, startedAt });

    const listen = settingsGet.listen();
    const { host, port } = splitListen(listen);

    server = http.createServer((req, res) => {
        applyCors(res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        route(req, res).catch(err => {
            logf(`[HTTP] 处理 ${req.method} ${req.url} 时出错：${err?.message ?? err}`);
            if (!res.headersSent) writeJSON(res, 500, { message: '内部错误：' + (err?.message ?? err) });
            else res.end();
        });
    });

    server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        server.once('error', (err) => {
            const hint = (err && err.code === 'EADDRINUSE')
                ? `：端口 ${port} 已被占用（可能仍有 Go 版 V.Adapter 或其他实例在运行，请先停止后重启酒馆）`
                : `：${err?.message ?? err}`;
            logf(`[Startup] ✗ 适配服务启动失败${hint}`);
            server = null;
            finish();
        });

        server.listen(port, host, () => {
            boundListen = listen;
            started = true;
            logf(`[Startup] ✓ 适配服务已启动：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/  （管理面板）`);
            logf(`[Startup] 客户端对接：NovelAI 渠道 URL 填 http://<本机IP>:${port}（不要带 /ai），Key 填服务端 nai_key`);
            logf(`[Startup] 上游：${settingsGet.qwenURL() || '（未配置）'} | 模型：${settingsGet.qwenModel() || '-'} | 链路：${settingsGet.chatFallback()}`);
            finish();
        });
    });

    return { listen: boundListen };
}

/** stopAdapterService 停止内嵌服务（酒馆退出时调用）。 */
export async function stopAdapterService() {
    if (!server) {
        started = false;
        return;
    }
    const s = server;
    server = null;
    started = false;
    boundListen = '';
    await new Promise((resolve) => {
        try {
            s.close(() => resolve());
        } catch {
            resolve();
        }
        // 兜底：1.5s 内没关干净就强制断开（否则酒馆退出会卡）
        setTimeout(() => {
            try { s.closeAllConnections?.(); } catch { /* 忽略 */ }
            resolve();
        }, 1500);
    });
}

/** getAdapterStatus 供酒馆路由 /api/plugins/v-adapter/status 使用的只读状态。 */
export function getAdapterStatus() {
    return {
        running: started,
        listen: boundListen || settingsGet.listen(),
        version,
        upstream: settingsGet.qwenURL(),
        model: settingsGet.qwenModel(),
        chat_fallback: settingsGet.chatFallback(),
    };
}

// splitListen 把 "0.0.0.0:8888" / "127.0.0.1:8888" / ":8888" 拆成 host + port。
function splitListen(listen) {
    const s = String(listen ?? '').trim() || '0.0.0.0:8888';
    const idx = s.lastIndexOf(':');
    let host = idx >= 0 ? s.slice(0, idx).trim() : '';
    const port = parseInt(idx >= 0 ? s.slice(idx + 1) : s, 10);
    if (!host) host = '0.0.0.0';
    if (!Number.isFinite(port) || port < 1 || port > 65535) return { host: '0.0.0.0', port: 8888 };
    return { host, port };
}
