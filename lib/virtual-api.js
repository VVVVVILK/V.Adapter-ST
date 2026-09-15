// virtual-api.js — 管理端点虚拟路由（面板 fetch 的后端）。
// 1:1 移植自 V.Adapter（Go）admin.go + auth.go 的处理器逻辑：
// Go 版这些端点是真实 HTTP 路由；扩展版运行在酒馆页面里，面板经桥接函数
// 直接调用这里的处理器，返回结构（{ok, status, data}）与原 HTTP 响应一致。
//
// 会话说明：扩展版面板运行在用户浏览器中（无服务端可供保护），
// /admin/auth/status 恒等价于原版「未设置密码 = 放行」状态；设置中心里的
// 面板密码功能照常保留（设置/修改/关闭均可保存）。

import { settingsGet, settingsView, applySettings, normalizeSizeStr } from './settings.js';
import { genLog, genLogCap, newRecord } from './genlog.js';
import { generateImage, logf, mimeForExt, truncate, bytesToBase64 } from './pipeline.js';
import { translateCharacter, mergeNegative, translateDefaultNegative } from './translate.js';

export const version = 'v1.1.4-st.1'; // 移植自 Go 版 v1.1.4；-st = SillyTavern 扩展版
const startTime = Date.now();

// panelPasswordSet / hashPassword（auth.go 对应，保留功能语义）
const panelCookieName = 'v_adapter_panel';

function hashPassword(pw) {
    // 同步 sha-256 不可得，退化为 djb2 变体（纯前端环境仅作占位存储，不再承担鉴权）
    let h = 5381;
    for (let i = 0; i < pw.length; i++) {
        h = ((h << 5) + h + pw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ── 主路由（面板桥接入口）──

// handleApi 处理面板请求，返回 { ok, status, data }。
// path 形如 '/admin/status'；method 'GET'|'POST'|'DELETE'；body 为解析后的对象或 undefined。
export async function handleApi(path, method, body) {
    try {
        switch (`${method} ${path}`) {
            case 'GET /admin/auth/status':
                return json(200, { success: true, setup_required: false, locked: false });
            case 'POST /admin/auth/login':
            case 'POST /admin/auth/setup':
            case 'POST /admin/auth/logout':
                return handleAuth(method, path, body);
            case 'GET /admin/status':
                return json(200, adminStatus());
            case 'GET /admin/settings':
                return json(200, { success: true, settings: settingsView() });
            case 'POST /admin/settings':
                return handleAdminSettingsPost(body);
            case 'POST /admin/test':
                return handleAdminTest(body);
            case 'POST /admin/translate':
                return handleAdminTranslate(body);
            case 'GET /admin/logs':
            case 'DELETE /admin/logs':
                return handleAdminLogs(path, method);
            default:
                return json(404, { success: false, error: `未找到端点：${path}` });
        }
    } catch (err) {
        return json(500, { success: false, error: truncate(String(err?.message ?? err), 500) });
    }
}

function json(status, data) {
    return { ok: status >= 200 && status < 300, status, data };
}

// handleAuth 面板密码端点（功能保留；扩展形态不锁定面板）。
function handleAuth(method, path, body) {
    if (path === '/admin/auth/setup') {
        const password = String(body?.password ?? '').trim();
        if (!password) {
            return json(200, { success: true, closed: true });
        }
        if (password.length < 4) {
            return json(400, { success: false, error: '密码至少 4 位' });
        }
        // 保存（扩展形态仅存储，不参与锁定）
        try {
            const ctx = getPanelStore();
            ctx.password_hash = hashPassword(password);
            savePanelStore(ctx);
        } catch { /* 存储失败不阻塞 */ }
        return json(200, { success: true });
    }
    if (path === '/admin/auth/login') {
        return json(200, { success: true });
    }
    // logout
    return json(200, { success: true });
}

function getPanelStore() {
    const v = localStorage.getItem(panelCookieName);
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}
function savePanelStore(obj) {
    localStorage.setItem(panelCookieName, JSON.stringify(obj));
}

// adminStatus GET /admin/status → 运行状态 + 脱敏配置 + 最近记录。
function adminStatus() {
    const [success, fail] = genLog.Counters();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const d = new Date(startTime);
    const pad = n => String(n).padStart(2, '0');
    return {
        status: 'ok',
        version,
        started_at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        uptime_seconds: uptimeSeconds,
        listen: '内置（随酒馆运行，无需独立端口）',
        settings: settingsView(),
        counters: { success, fail, total: success + fail },
        recent: genLog.Snapshot(10),
    };
}

// handleAdminSettingsPost POST /admin/settings。
function handleAdminSettingsPost(body) {
    const inner = body?.settings && typeof body.settings === 'object' ? body.settings : (body ?? {});
    const [changed, notes] = applySettings(inner);
    for (const k of changed) {
        if (k === 'nai_key' && settingsGet.naiKey() !== '') {
            logf('[Settings] nai_key 已更新（客户端须同步改 Key）');
        }
        if (k === 'qwen_key') {
            logf('[Settings] qwen_key 已更新');
        }
    }
    return json(200, { success: true, changed, notes, settings: settingsView() });
}

// targetFromSettings 面板热设置快照（pipeline 用）。
function targetFromSettings() {
    return {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
}

// handleAdminTest POST /admin/test → 实调一次上游生图，返回耗时/链路/预览图。
// body 可选覆盖（不落盘、不影响线上配置）：{url, key, model, size, prompt}
async function handleAdminTest(body) {
    const toStr = v => (typeof v === 'string' ? v : '');
    const target = targetFromSettings();
    if (toStr(body?.url).trim()) target.url = toStr(body.url).trim();
    if (toStr(body?.key).trim()) target.key = toStr(body.key).trim();
    if (toStr(body?.model).trim()) target.model = toStr(body.model).trim();
    let size = settingsGet.defaultSize();
    const sizeNorm = normalizeSizeStr(toStr(body?.size).trim());
    if (sizeNorm) size = sizeNorm;
    let prompt = toStr(body?.prompt).trim();
    if (!prompt) prompt = '一只红色的苹果放在木桌上，柔和光线，静物摄影，测试图';

    const start = Date.now();
    let res, err = null;
    try {
        res = await generateImage(target, prompt, '', size, settingsGet.chatFallback());
    } catch (e) {
        err = e;
    }
    const latency = Date.now() - start;

    const rec = newRecord({
        kind: 'test', endpoint: '/admin/test', model: target.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    if (err) {
        rec.status = 502;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        logf(`[Test] 测试连接失败（${latency}ms）：${err.message}`);
        return json(502, { success: false, error: truncate(err.message, 500) });
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = res.via;
    genLog.Add(rec);
    logf(`[Test] 测试连接成功（${latency}ms via ${res.via}）：${size} ${res.ext} ${Math.floor((res.data?.length ?? 0) / 1024)}KB`);

    return json(200, {
        success: true,
        latency_ms: latency,
        model: target.model,
        size: size,
        via: res.via,
        ext: res.ext,
        bytes: res.data?.length ?? 0,
        preview: imagePreview(res),
        message: `生成成功：耗时 ${latency}ms，链路 ${res.via}`,
    });
}

// imagePreview 结果 → 预览 data URL（降级时为远程 URL，<img> 均可显示）。
export function imagePreview(res) {
    if (res.data) {
        return `data:${mimeForExt(res.ext)};base64,${bytesToBase64(res.data)}`;
    }
    return res.remoteUrl ?? '';
}

// handleAdminTranslate POST /admin/translate → 角色转译 + 直接出图。
//
// 这个功能的目的是「拿一句话描述直接出图」，转译出来的提示词只是中间产物（同时展示出来供参考/复制）。
//
//	body: {
//	  text     string  描述（必填；若给了 prompt 则跳过转译，直接用 prompt 出图）
//	  prompt   string  可选：直接指定总提示词（面板「再出一张」用，避免重新转译导致画风漂移）
//	  negative string  可选：直接指定负面词
//	  generate bool    可选：转译后立刻出图
//	  style    bool    可选：出图时套用面板「画风预设」
//	  size     string  可选："宽x高"，覆盖转译推荐的尺寸
//	}
//
// 返回 data 为转译结果；generate=true 时额外带 preview/via/ext/bytes/latency_ms/used_size；
// 若转译成功但出图失败，仍是 200，错误放在 image_error 里（避免抹掉已经拿到的提示词）。
async function handleAdminTranslate(body) {
    const req = {
        text: String(body?.text ?? ''),
        prompt: String(body?.prompt ?? ''),
        negative: String(body?.negative ?? ''),
        generate: !!body?.generate,
        size: String(body?.size ?? ''),
    };

    const res = { prompt: '', character_prompt: '', main_prompt: '', negative_prompt: '', width: 832, height: 1216, steps: 28, cfg_scale: 7.0 };
    if (req.prompt.trim()) {
        // 「再出一张」：沿用上一次的提示词，不再走转译
        let neg = req.negative.trim();
        if (!neg) neg = mergeNegative(translateDefaultNegative);
        res.prompt = req.prompt.trim();
        res.negative_prompt = neg;
    } else {
        try {
            const r = await translateCharacter(targetFromSettings(), req.text);
            Object.assign(res, r);
        } catch (err) {
            logf(`[Translate] 转译失败：${err.message}`);
            return json(502, { success: false, error: truncate(err.message, 300) });
        }
        logf(`[Translate] 转译成功：${truncate(req.text.trim(), 40)} → 总提示词 ${[...res.prompt].length} 字`);
    }

    const out = { success: true, data: res };
    if (!req.generate) {
        return json(200, out);
    }

    const target = targetFromSettings();
    let prompt = res.prompt.trim();
    if (!prompt) prompt = (res.character_prompt + '，' + res.main_prompt).trim();
    let neg = res.negative_prompt;
    let size = `${res.width}x${res.height}`;
    const sizeNorm = normalizeSizeStr(req.size.trim());
    if (sizeNorm) size = sizeNorm;

    const start = Date.now();
    let img, gerr = null;
    try {
        img = await generateImage(target, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    const latency = Date.now() - start;
    const rec = newRecord({
        kind: 'translate', endpoint: '/admin/translate', model: target.model,
        prompt: truncate(prompt, 80), size, latency_ms: latency,
    });
    out.latency_ms = latency;
    out.used_size = size;
    out.used_prompt = prompt;
    if (gerr) {
        rec.status = 502;
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        logf(`[Translate] 出图失败（${latency}ms）：${gerr.message}`);
        out.image_error = truncate(gerr.message, 500);
        return json(200, out);
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = img.via;
    genLog.Add(rec);
    logf(`[Translate] 出图成功（${latency}ms via ${img.via}）：${size} ${img.ext} ${Math.floor((img.data?.length ?? 0) / 1024)}KB`);

    out.preview = imagePreview(img);
    out.via = img.via;
    out.ext = img.ext;
    out.bytes = img.data?.length ?? 0;
    out.used_negative = neg;
    return json(200, out);
}

// handleAdminLogs GET /admin/logs（?limit=N） / DELETE /admin/logs（清空历史）。
// 面板桥接的 path 带 query（如 '/admin/logs?limit=200'）。
function handleAdminLogs(path, method) {
    if (method === 'DELETE') {
        genLog.Clear();
        return json(200, { success: true });
    }
    let limit = 100;
    const m = /[?&]limit=(\d+)/.exec(path);
    if (m && parseInt(m[1], 10) > 0) limit = parseInt(m[1], 10);
    const [success, fail] = genLog.Counters();
    return json(200, {
        success: true,
        logs: genLog.Snapshot(limit),
        cap: genLogCap,
        counters: { success, fail, total: success + fail },
    });
}
