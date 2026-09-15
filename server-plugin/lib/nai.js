// nai.js — NovelAI 协议兼容端点（客户端 NovelAI 渠道的调用面）。
// 1:1 移植自 V.Adapter（Go）nai_handler.go：
//
//	POST /ai/generate-image    生图：请求是 NovelAI 格式 JSON，响应必须是 ZIP（内含一张图）
//	GET  /ai/user/subscription 测试连接：返回 200+订阅 JSON（客户端显示「连接正常:Free」）
//	POST /ai/encode-vibe       vibe 编码：本服务不支持，返回 404
//
// 错误一律使用非 2xx + {"message": "…"}：客户端会取 message 字段展示给用户，
// 因此错误信息必须是可读文本，不能是裸状态码。
//
// 非标准扩展参数（查询串，不影响标准 NAI 客户端）：
//
//	raw=1     响应直出图片字节，不套 ZIP 壳
//	expand=1  先把 input 交给聊天模型扩写为完整画面提示词再出图（见 expandInput）

import crypto from 'node:crypto';
import { settingsGet, normalizeSizeOrDefault } from './settings.js';
import { genLog, newRecord } from './genlog.js';
import { generateImage, truncate, mimeForExt } from './pipeline.js';
import { translateCharacter } from './translate.js';
import { createZip } from './zip.js';

// naiKeyGate 校验客户端带来的 Bearer key（服务端 nai_key 为空 = 不校验）。
export function naiKeyGate(handler) {
    return async (req, res, ctx) => {
        const want = settingsGet.naiKey();
        if (want !== '') {
            const auth = String(req.headers['authorization'] ?? '');
            let got = auth.replace(/^Bearer\s+/i, '').trim();
            const a = Buffer.from(got);
            const b = Buffer.from(want);
            const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
            if (!ok) {
                return sendJSON(res, 401, {
                    message: 'API Key 不正确：请在客户端 NovelAI 渠道把 Key 填成与服务端一致的值（可在管理面板查看/修改）',
                    statusCode: 401,
                });
            }
        }
        return handler(req, res, ctx);
    };
}

// ── NAI 请求体取值小工具（对应 Go nai_handler.go 的同名函数）──

function strFromMap(m, key) {
    if (!m) return '';
    const v = m[key];
    return typeof v === 'string' ? v.trim() : '';
}

function numFromMap(m, key) {
    if (!m) return null;
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const f = parseFloat(v.trim());
        if (Number.isFinite(f)) return f;
    }
    return null;
}

function numStr(m, key) {
    const v = numFromMap(m, key);
    return v === null ? '-' : String(Math.round(v));
}

// v4BaseNegative 部分模型把负向词放在 v4_negative_prompt.caption.base_caption。
function v4BaseNegative(params) {
    if (!params) return '';
    const v4 = params.v4_negative_prompt;
    if (!v4 || typeof v4 !== 'object') return '';
    const cap = v4.caption;
    if (!cap || typeof cap !== 'object') return '';
    return typeof cap.base_caption === 'string' ? cap.base_caption.trim() : '';
}

// defaultSizeWH 解析默认尺寸，兜底 1024x1024。
function defaultSizeWH() {
    const s = normalizeSizeOrDefault(settingsGet.defaultSize());
    const [w, h] = s.split('x').map(v => parseInt(v, 10));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [1024, 1024];
    return [w, h];
}

function clampInt(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

export function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

// promptHeaders 把本次实际送入上游的提示词与扩写状态放在响应头上回传，
// 供面板类调用方展示与核对。标准 NAI 客户端不会读取这些头，不影响协议兼容性。
// 头值必须是 ASCII，因此提示词按 URL 编码传递，并在编码前截断（避免超出头部长度上限）。
function promptHeaders(prompt, expandFlag) {
    const h = {};
    if (expandFlag) h['X-Illust-Expand'] = expandFlag;
    const s = String(prompt ?? '');
    const cut = s.length > 600 ? s.slice(0, 600) + '…' : s;
    const enc = encodeURIComponent(cut);
    if (enc) h['X-Illust-Prompt'] = enc;
    return h;
}

/**
 * expandInput 用聊天模型把简短描述扩写为完整画面提示词（复用 lib/translate.js 的「角色转译」）。
 *
 * 任何失败均以 { ok:false } 返回，由调用方回退为原样送，因此本函数不抛异常。
 * 回退原因写入生成记录：扩写请求失败、超时、返回为空、长度异常（超过原输入 5 倍且大于 400 字符）。
 *
 * @param {{url:string,key:string,model:string}} target 上游聊天接口
 * @param {string} text 原始 input
 * @param {{logf:Function}} ctx
 * @returns {Promise<{ok:true,prompt:string,negative:string,size:[number,number]}|{ok:false,error:string}>}
 */
async function expandInput(target, text, ctx) {
    const rec = newRecord({
        kind: 'expand', endpoint: '/chat/completions', model: target.model,
        prompt: truncate(text, 80), size: '-',
    });
    const t0 = Date.now();
    try {
        const r = await translateCharacter(target, text);
        const expanded = String(r.prompt || r.character_prompt || r.main_prompt || '').trim();
        if (!expanded) throw new Error('扩写结果为空');
        const limit = Math.max(400, text.length * 5);
        if (expanded.length > limit) {
            throw new Error(`扩写结果长度异常（${expanded.length} 字符，上限 ${limit}）`);
        }

        rec.ok = true;
        rec.status = 200;
        rec.latency_ms = Date.now() - t0;
        rec.prompt = truncate(expanded, 80);
        rec.size = `${r.width}x${r.height}`;
        genLog.Add(rec);
        ctx.logf(`[Expand] 扩写成功（${rec.latency_ms}ms）：${[...text].length}字 → ${[...expanded].length}字，推荐 ${rec.size}`);
        return {
            ok: true,
            prompt: expanded,
            negative: String(r.negative_prompt ?? '').trim(),
            size: [r.width, r.height],
        };
    } catch (err) {
        rec.ok = false;
        rec.status = 502;
        rec.latency_ms = Date.now() - t0;
        rec.error = truncate(err.message, 300);
        genLog.Add(rec);
        ctx.logf(`[Expand] 扩写失败，回退为原样送：${err.message}`);
        return { ok: false, error: err.message };
    }
}

// wantsExpand 客户端是否要求先扩写输入（查询串带 `expand=1`）。
function wantsExpand(req) {
    return /[?&]expand=1(?:&|$)/.test(String(req?.url ?? ''));
}

// handleGenerateImage POST /ai/generate-image → ZIP
export async function handleGenerateImage(req, res, ctx) {
    const start = Date.now();
    if (req.method !== 'POST') {
        return sendJSON(res, 405, { message: '仅支持 POST' });
    }

    let raw;
    try {
        raw = await ctx.readBody(32 << 20);
    } catch (err) {
        return sendJSON(res, 400, { message: '读取请求体失败：' + err.message });
    }

    // 容忍个别客户端/工具带来的 UTF-8 BOM
    let text = Buffer.from(raw).toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    let body;
    try {
        body = JSON.parse(text);
        // 与 Go 版的宽容解析一致（结构体缺字段即零值）
        body = body && typeof body === 'object' ? body : {};
    } catch (err) {
        return sendJSON(res, 400, { message: '请求体不是合法 JSON：' + err.message });
    }

    let prompt = String(body.input ?? '').trim();
    let params = body.parameters && typeof body.parameters === 'object' ? body.parameters : null;
    let neg = strFromMap(params, 'negative_prompt');
    if (!neg) neg = v4BaseNegative(params);

    // 客户端显式指定的尺寸（缺失时可由扩写推荐值补位，见下方 recSize）
    const reqW = numFromMap(params, 'width');
    const reqH = numFromMap(params, 'height');

    const target = {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };

    // ── 可选：输入扩写（客户端查询串带 `expand=1` 时启用）──
    // 把 input 交给聊天模型扩写为完整画面提示词，供 V.Canvas「转译出图」等由简短描述发起的入口使用。
    // 失败、超时、返回为空或长度异常时回退为原样送出，不阻断出图；回退事件写入生成记录。
    let recSize = null;
    let expandFlag = '';
    if (wantsExpand(req) && prompt !== '') {
        const e = await expandInput(target, prompt, ctx);
        if (e.ok) {
            prompt = e.prompt;
            if (e.negative) neg = neg ? `${neg}, ${e.negative}` : e.negative;
            recSize = e.size;
            expandFlag = 'ok';
        } else {
            expandFlag = 'fallback';
        }
    }

    const [defW, defH] = defaultSizeWH();
    let width = defW, height = defH;
    if (reqW !== null && reqW >= 16) width = clampInt(Math.round(reqW), 64, 2048);
    else if (recSize) width = clampInt(Math.round(recSize[0]), 64, 2048);
    if (reqH !== null && reqH >= 16) height = clampInt(Math.round(reqH), 64, 2048);
    else if (recSize) height = clampInt(Math.round(recSize[1]), 64, 2048);
    const size = `${width}x${height}`;

    const rec = newRecord({
        kind: 'generate', endpoint: '/ai/generate-image', model: target.model,
        prompt: truncate(prompt, 80), size,
    });

    if (prompt === '') {
        rec.status = 400;
        rec.error = '正向提示词（input）为空';
        genLog.Add(rec);
        return sendJSON(res, 400, { message: '正向提示词（input）为空，客户端未拼出正向词' });
    }

    ctx.logf(`[Gen] 生图请求 model=${JSON.stringify(body.model ?? '')} size=${size} steps=${numStr(params, 'steps')} seed=${numStr(params, 'seed')} 负向词=${[...neg].length}字 正向词=${[...prompt].length}字`);

    let result, gerr = null;
    try {
        result = await generateImage(target, prompt, neg, size, settingsGet.chatFallback());
    } catch (e) {
        gerr = e;
    }
    rec.latency_ms = Date.now() - start;

    if (gerr) {
        rec.ok = false;
        rec.status = 502;
        rec.via = 'images';
        rec.error = truncate(gerr.message, 300);
        genLog.Add(rec);
        ctx.logf(`[Gen] 生图失败（${rec.latency_ms}ms）：${gerr.message}`);
        return sendJSON(res, 502, { message: truncate(gerr.message, 500), statusCode: 502 });
    }

    rec.ok = true;
    rec.status = 200;
    rec.via = result.via;
    genLog.Add(rec);
    ctx.logf(`[Gen] 生图成功（${rec.latency_ms}ms via ${result.via}）：${size} ${result.ext} ${Math.floor((result.data?.length ?? 0) / 1024)}KB`);

    // 先拿到图片字节（本地已有就直接用；只有远程链接时由服务端代下载一次）
    let bytes = null;
    try {
        if (result.data) {
            bytes = result.data;
        } else if (result.remoteUrl) {
            // 跨域降级：本地拿不到字节，服务端代下载一次（服务端无跨域限制，通常能成功）
            const dl = await fetch(result.remoteUrl);
            if (!dl.ok) throw new Error(`代下载图片失败：HTTP ${dl.status}`);
            bytes = new Uint8Array(await dl.arrayBuffer());
        } else {
            throw new Error('生图结果为空');
        }
    } catch (err) {
        ctx.logf(`[Gen] 取图失败：${err.message}`);
        return sendJSON(res, 502, { message: '取图失败：' + err.message });
    }

    // ── 直出模式：客户端声明只要图片（`Accept: image/*` 或查询串带 `raw=1`）时，
    //    直接把 PNG/JPEG 字节流回给它，**不套 ZIP 壳** —— 客户端拿到就能直接显示，
    //    省掉解包那一步。默认仍然回 ZIP，因为那是 NovelAI 协议的响应格式
    //    （酒馆助手以及任何标准 NAI 客户端都靠它）。──
    if (wantsRawImage(req)) {
        const buf = Buffer.from(bytes);
        ctx.logf(`[Gen] 直出图片（${result.ext}，${Math.floor(buf.length / 1024)}KB，未套 ZIP）`);
        res.writeHead(200, {
            'Content-Type': mimeForExt(result.ext),
            'Content-Length': buf.length,
            'Content-Disposition': `inline; filename="image_0.${result.ext}"`,
            'X-Illust-Via': result.via ?? '',
            ...promptHeaders(prompt, expandFlag),
        });
        res.end(buf);
        return;
    }

    // 打包 ZIP 返回（NovelAI 协议格式：客户端解包后取第一个图片文件）
    const zip = createZip('image_0.' + result.ext, bytes);

    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="image_0.zip"',
        'Content-Length': zip.length,
        'X-Illust-Via': result.via ?? '',
        ...promptHeaders(prompt, expandFlag),
    });
    res.end(zip);
}

// wantsRawImage 客户端是不是要「不套壳的图片」。
//   - `Accept` 里有 image/ 且没有主动要 zip  → 直出图片
//   - 查询串带 `raw=1`                        → 强制直出
//   - 其余（浏览器的 `*/*`、老客户端的 `application/zip`）→ 走标准 ZIP，保持协议兼容
function wantsRawImage(req) {
    const url = String(req?.url ?? '');
    if (/[?&]raw=1(?:&|$)/.test(url)) return true;
    const accept = String(req?.headers?.accept ?? '').toLowerCase();
    if (!accept) return false;
    return accept.includes('image/') && !accept.includes('zip');
}

// handleSubscription GET /ai/user/subscription → 订阅信息（客户端「测试连接」用）。
export function handleSubscription(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJSON(res, 405, { message: '仅支持 GET' });
    }
    sendJSON(res, 200, {
        tier: 0,
        active: true,
        subscription: { tier: 0, active: true, expiresAt: 0 },
    });
}

// handleEncodeVibe POST /ai/encode-vibe → 明确不支持（404）。
export function handleEncodeVibe(req, res) {
    sendJSON(res, 404, {
        message: '本服务不支持 vibe 参考图编码（后端是上游生图，无 vibe 能力）；请在客户端里关闭 vibe 参考图',
        statusCode: 404,
    });
}
