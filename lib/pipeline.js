// pipeline.js — 调用上游 OpenAI 兼容生图接口（扩展内置版）。
// 1:1 移植自 V.Adapter（Go）qwen_client.go，逻辑与文案逐字保留：
//   1. 优先 response_format=b64_json 取 data[0].b64_json 解码；
//   2. 没有 b64 则取 data[0].url 下载；
//   3. 带 negative_prompt 请求失败时自动去掉重试一次；
//   4. 返回非图片内容（风控验证码页 / HTML 错误页）时给出可读错误，并（auto 模式）
//      自动转聊天接口生图兜底；
//   5. 上游拒绝尺寸时回退到配置的默认尺寸重试一次；
//   6. 标准生图接口连续故障熔断（30 分钟内直接走聊天），换上游/设置变更自动解除。
//
// 浏览器环境等价适配（不改变行为语义）：
//   - 跨域：上游 API 需允许浏览器跨域（CORS）；图片 URL 若因 CORS 无法下载，
//     返回 remoteUrl 降级结果（图仍可直接使用，只是不走本地字节与去水印）。

import { removeWatermark } from './watermark.js';

// ── 错误类型（对应 Go 的 upstreamError / notImageError）──

export class UpstreamError extends Error {
    constructor(statusCode, body, msg) {
        super(msg);
        this.name = 'UpstreamError';
        this.statusCode = statusCode;
        this.body = body ?? '';
    }
}

export class NotImageError extends Error {
    constructor(msg) {
        super(msg);
        this.name = 'NotImageError';
    }
}

// imageResult 生成结果：图片字节 + 真实扩展名 + 走的链路。
// remoteUrl 存在时表示「未能下载字节，但链接可直接使用」的降级结果。
export class ImageResult {
    constructor(data, ext, via, remoteUrl) {
        this.data = data;      // Uint8Array | null
        this.ext = ext;        // png/jpg/webp/gif/bmp
        this.via = via;        // images / chat / images→chat兜底
        this.remoteUrl = remoteUrl ?? null;
    }
}

// chatImageInstruction 聊天生图指令。
export const chatImageInstruction = '请直接生成一张图片，不要输出多余文字。';

// 聊天回复里的图片链接提取（Markdown 图片 + 裸链接）。
const mdImageRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const bareURLRe = /https?:\/\/[^\s"'<>)\]]+/g;

// ── 标准生图接口熔断（auto 模式专用）──
let imagesBrokenCount = 0;
let imagesBrokenUntil = 0; // epoch ms；0 = 未熔断

const IMAGES_BROKEN_THRESHOLD = 3;
const IMAGES_BROKEN_COOLDOWN = 30 * 60 * 1000;

export function resetImagesBroken() {
    imagesBrokenCount = 0;
    imagesBrokenUntil = 0;
}

function imagesBroken() {
    return imagesBrokenUntil > 0 && Date.now() < imagesBrokenUntil;
}

function markImagesBroken() {
    imagesBrokenCount++;
    if (imagesBrokenCount >= IMAGES_BROKEN_THRESHOLD) {
        imagesBrokenUntil = Date.now() + IMAGES_BROKEN_COOLDOWN;
        logf(`[Upstream] 标准生图接口连续失败已达 ${IMAGES_BROKEN_THRESHOLD} 次，熔断 30m0s，期间直接走聊天接口`);
    }
}

function markImagesOK() {
    imagesBrokenCount = 0;
    imagesBrokenUntil = 0;
}

// logf 扩展控制台日志（红色渲染交给控制台自己）。
export function logf(line) {
    console.log(`[V.Adapter] ${line}`);
}

// ── 对外主入口 ──

// target 一次调用所需的上游参数（面板热设置快照 / 测试覆盖值）。
function targetFromSettings() {
    return {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
}

// generateImage 按模式（auto/off/chat_only/openai）生成一张图。
export async function generateImage(target, prompt, neg, size, mode) {
    mode = normalizeChatFallbackMode(mode);
    if (mode === 'chat_only') {
        try {
            return await generateViaChat(target, prompt, neg);
        } catch (err) {
            // chat_only 现在是默认链路。若上游其实是生图模型（聊天接口画不了图），
            // 这里必须把出路写清楚，避免被误判成插件故障。
            throw new Error(`${err.message}；当前生图链路为「仅聊天接口」（chat_only）。` +
                '若上游是生图模型（qwen-image / dall-e-3 等），请在「设置中心」把生图链路改为 auto 或 off');
        }
    }
    if (mode === 'openai') {
        // openai 模式：纯标准 OpenAI 图生接口（/images/generations），
        // 面向各类 OpenAI 兼容 API（官方/第三方），不做反代聊天兜底；失败即报错。
        const res = await generateViaImages(target, prompt, neg, size);
        markImagesOK();
        return res;
    }
    if (mode === 'auto' && imagesBroken()) {
        logf('[Upstream] 标准生图接口处于熔断窗口，直接走聊天接口');
        const res = await generateViaChat(target, prompt, neg);
        res.via = 'chat（标准接口熔断）';
        return res;
    }
    let res;
    try {
        res = await generateViaImages(target, prompt, neg, size);
        markImagesOK();
        return res;
    } catch (err) {
        if (mode === 'auto' && shouldTryChat(err)) {
            if (imagesEndpointUnavailable(err)) {
                markImagesBroken();
            }
            logf(`[Upstream] 标准生图未拿到图片（${err.message}），转聊天接口兜底 …`);
            try {
                const res2 = await generateViaChat(target, prompt, neg);
                res2.via = 'images→chat兜底';
                return res2;
            } catch (err2) {
                throw new Error(`${err.message}；聊天生图兜底也失败：${err2.message}`);
            }
        }
        throw err;
    }
}

// normalizeChatFallbackMode（对应 Go normalizeChatFallback，供 pipeline 与 settings 共用语义）。
export function normalizeChatFallbackMode(s) {
    switch (String(s ?? '').toLowerCase().trim()) {
        case 'off': return 'off';
        case 'chat_only': return 'chat_only';
        case 'openai': return 'openai';
        default: return 'auto';
    }
}

// generateViaImages 标准生图接口，按「尺寸回退 + negative_prompt 降级」组合尝试。
async function generateViaImages(target, prompt, neg, size) {
    if (!size) size = target.defaultSize;
    const queue = [{ size, neg }];
    const tried = new Set();
    let lastErr = null;
    // 上限 6 次（去重后实际最多 4 种组合：原尺寸/默认尺寸 × 带/不带 negative_prompt）
    for (let i = 0; i < queue.length && i < 6; i++) {
        const a = queue[i];
        const key = a.size + '|' + a.neg;
        if (tried.has(key)) continue;
        tried.add(key);
        try {
            return await imagesOnce(target, prompt, a.neg, a.size);
        } catch (err) {
            lastErr = err;
            if (err instanceof UpstreamError) {
                // 尺寸不被接受：回退到配置的默认尺寸再试
                if (sizeRelated(err.body) && a.size !== target.defaultSize && target.defaultSize) {
                    logf(`[Upstream] 尺寸 ${a.size} 被上游拒绝，回退默认尺寸 ${target.defaultSize} 重试`);
                    queue.push({ size: target.defaultSize, neg: a.neg });
                }
                // negative_prompt 非标准字段：失败即去掉重试
                if (a.neg) {
                    logf(`[Upstream] 带 negative_prompt 请求失败（HTTP ${err.statusCode}），去掉该字段重试`);
                    queue.push({ size: a.size, neg: '' });
                }
            }
        }
    }
    throw lastErr ?? new Error('上游生图请求失败');
}

// imagesOnce 单次标准生图请求（一次尝试）。
async function imagesOnce(target, prompt, neg, size) {
    const body = {
        model: target.model,
        prompt: prompt,
        size: size,
        n: 1,
        response_format: 'b64_json',
    };
    if (neg) body.negative_prompt = neg;

    const { raw, status } = await postJSON(target, '/images/generations', body, 300 * 1000);
    if (status < 200 || status >= 300) {
        throw new UpstreamError(status, raw, `上游生图接口返回 HTTP ${status}：${snippet(raw, 300)}`);
    }
    let resp;
    try { resp = JSON.parse(raw); } catch {
        throw new NotImageError(`上游生图接口响应不是合法 JSON（片段：${snippet(raw, 150)}）`);
    }
    if (!resp.data || !resp.data.length) {
        throw new NotImageError(`上游生图接口响应里没有 data[0]（片段：${snippet(raw, 150)}）`);
    }
    const item = resp.data[0];
    const b64 = String(item.b64_json ?? '').trim();
    if (b64) {
        let b = b64;
        if (b.startsWith('data:')) {
            const i = b.indexOf(',');
            if (i >= 0) b = b.slice(i + 1);
        }
        let bytes = null;
        try { bytes = b64ToBytes(b); } catch { bytes = null; }
        if (bytes) return decodeImageBytes(bytes, 'images');
        throw new NotImageError('上游生图接口返回的 b64_json 无法 base64 解码');
    }
    const u = String(item.url ?? '').trim();
    if (u) {
        const dl = await downloadImage(u);
        if (dl.bytes) return decodeImageBytes(dl.bytes, 'images');
        // CORS 下载失败：返回远程链接降级结果（图可直接使用）
        return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'images', dl.url);
    }
    throw new NotImageError('API 响应中既没有 b64_json 也没有 url，请检查兼容服务');
}

// generateViaChat 聊天接口生图兜底。
async function generateViaChat(target, prompt, neg) {
    let instruction = chatImageInstruction;
    if (neg) instruction += '\n请务必避免以下元素：' + neg;
    const messages = [{ role: 'user', content: instruction + '\n' + prompt }];

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
            logf('[Upstream] 聊天接口瞬时故障，6s 后重试 …');
            await delay(6000);
        }
        const body = { model: target.model, messages: messages, max_tokens: 2000 };
        let raw, status, err;
        try {
            ({ raw, status } = await postJSON(target, '/chat/completions', body, 320 * 1000));
        } catch (e) {
            err = e;
        }
        if (err) {
            lastErr = err;
            if (transientErr(err)) continue;
            throw err;
        }
        if (status < 200 || status >= 300) {
            const ue = new UpstreamError(status, raw, `上游聊天接口返回 HTTP ${status}：${snippet(raw, 300)}`);
            lastErr = ue;
            if (transientErr(ue)) continue;
            throw ue;
        }
        let cr;
        try { cr = JSON.parse(raw); } catch { cr = null; }
        if (!cr || !cr.choices || !cr.choices.length) {
            throw new NotImageError(`上游聊天接口响应缺少 choices（片段：${snippet(raw, 150)}）`);
        }
        const content = cr.choices[0].message?.content ?? '';
        const { urls, seenPunish } = extractImageURLs(content);
        if (!urls.length) {
            throw new NotImageError(noImageURLDiag(content, seenPunish));
        }
        for (const u of urls) {
            const dl = await downloadImage(u);
            if (dl.bytes) {
                const res = decodeImageBytes(dl.bytes, 'chat');
                // 聊天链路来自上游官网的图带右下角 "Qwen" 角标，统一抹除
                res.data = await removeWatermark(res.data, res.ext);
                return res;
            }
            if (dl.remoteUrl) {
                // CORS 下载失败：远程链接降级（去水印跳过，图可直接显示）
                logf('[Upstream] 图片因跨域限制无法本地处理，直接使用原始链接');
                return new ImageResult(null, sniffExtFromUrl(u) || 'png', 'chat', dl.remoteUrl);
            }
            lastErr = dl.error ?? new Error('图片下载失败');
        }
        throw new NotImageError('聊天生图返回的图片链接均无法下载或解析');
    }
    throw lastErr ?? new Error('聊天生图请求失败');
}

// ── HTTP 基础 ──

// postJSON 向 target.url+path POST 一段 JSON，返回响应体文本与状态码。
// 也供 translate.js 复用（同一上游通道）。
export async function postJSON(target, path, body, timeoutMs) {
    const base = String(target.url ?? '').trim().replace(/\/+$/, '');
    if (!base) {
        throw new Error('上游 API 地址未配置：请在管理面板「设置中心」填写 API 地址');
    }
    const key = String(target.key ?? '').trim();
    // 请求头只允许 ISO-8859-1 字符：出厂默认密钥含中文，浏览器会直接拒发请求
    // （报 "String contains non ISO-8859-1 code point"）。提前拦截并给出可读指引。
    if (/[^\x00-\xFF]/.test(key)) {
        throw new Error('API 密钥还是出厂默认值（含中文）：请打开管理面板「设置中心」，填入你自己的上游地址、密钥与模型后再试');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(base + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (key || 'EMPTY'), // 本地免鉴权服务用占位符
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`上游接口超时（${base + path} 未在 ${formatDuration(timeoutMs)} 内响应）`);
        }
        throw new Error(`请求上游接口失败（${base + path}）: ${err.message}（若为跨域报错，请让上游 API 允许浏览器 CORS 访问）`);
    } finally {
        clearTimeout(timer);
    }
    const raw = await resp.text();
    return { raw, status: resp.status };
}

// downloadImage 下载 data[0].url 或聊天回复里的图片链接。
// 返回 { bytes }（成功）/ { remoteUrl }（CORS 降级）/ { error }（失败）。
async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180 * 1000);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (resp.status !== 200) {
            return { error: new Error(`下载生成图片失败：HTTP ${resp.status}（${url}）`) };
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        return { bytes: buf };
    } catch (err) {
        // 多为浏览器 CORS 限制：给出可直接使用的远程链接降级
        if (controller.signal.aborted) {
            return { error: new Error(`下载生成图片失败：超时（${url}）`) };
        }
        return { remoteUrl: url };
    } finally {
        clearTimeout(timer);
    }
}

// ── 图片识别与诊断 ──

// sniffImage 按魔数识别图片格式，返回扩展名（png/jpg/webp/gif/bmp）。
export function sniffImage(b) {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'png';
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
    if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
    if (b.length >= 6) {
        const six = String.fromCharCode(...b.slice(0, 6));
        if (six === 'GIF87a' || six === 'GIF89a') return 'gif';
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
    return null;
}

function sniffExtFromUrl(u) {
    const m = /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.exec(u);
    if (!m) return null;
    return m[1].toLowerCase().replace('jpeg', 'jpg');
}

// decodeImageBytes 校验字节确为图片；否则给出可读诊断。
export function decodeImageBytes(raw, via) {
    const ext = sniffImage(raw);
    if (!ext) throw new NotImageError(nonImageDiag(raw));
    return new ImageResult(raw, ext, via, null);
}

// nonImageDiag 非图片内容的诊断文案（面向用户的可读措辞）。
function nonImageDiag(raw) {
    const head = raw.slice(0, Math.min(raw.length, 2048));
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(head); } catch { text = ''; }
    const low = text.trimStart().toLowerCase();
    if (low.startsWith('<!doctype') || low.startsWith('<html') || (low.length > 0 && low[0] === '<')) {
        return 'API 返回的不是图片，而是一个网页/HTML（常见原因：中转服务的风控验证码页、登录失效页或 502 错误页，请检查该 API 服务本身能否生图）';
    }
    if (low.includes('error') || low.includes('exception')) {
        return `API 返回的不是图片，疑似错误信息：${JSON.stringify(snippet(text, 200))}`;
    }
    return 'API 返回的数据无法解析为图片（内容类型异常，请检查 API 服务）';
}

// extractImageURLs 从聊天回复里提取图片链接，并识别风控 punish 页。
function extractImageURLs(content) {
    const all = [];
    for (const m of content.matchAll(mdImageRe)) all.push(m[1]);
    for (const m of content.matchAll(bareURLRe)) all.push(m[0]);

    const urls = [];
    const seen = new Set();
    let seenPunish = false;
    for (const u of all) {
        if (seen.has(u)) continue;
        seen.add(u);
        const lu = u.toLowerCase();
        if (lu.includes('punish') || lu.includes('captcha')) {
            seenPunish = true;
            continue;
        }
        urls.push(u);
    }
    return { urls, seenPunish };
}

// noImageURLDiag 聊天拿不到图片链接时的统一诊断。
function noImageURLDiag(content, seenPunish) {
    if (seenPunish) {
        return '上游被上游风控拦截（返回 punish 验证页），生图未生成图片。' +
            '风控通常几分钟后自动解除：请稍等再试、放慢连续生图节奏，或换个描述词再试';
    }
    let sn = truncate(content.trim(), 150);
    if (!sn) sn = '（模型未返回任何图片链接）';
    for (const m of ['无法生成', '无法直接生成', '不能生成', '无法创建',
        '内容政策', '安全规范', '不适宜', '色情', '裸露', '违反']) {
        if (content.includes(m)) {
            return '上游生图模型基于其内容安全策略拒绝了本次请求，模型回复：' + sn +
                '。这是上游服务的策略而非本地工具故障；可调整描述规避敏感元素后再试';
        }
    }
    return '聊天生图未返回图片链接，模型回复：' + sn;
}

// ── 判定小工具 ──

// imagesEndpointUnavailable 判定「标准生图接口当前不可用」——熔断计数的依据。
//
// 与上游网关（qwen2api）的错误契约对齐，优先看结构化字段，不靠猜文案：
//   code:  upstream_waf_challenge（上游被阿里云 WAF 拦，返回验证码页）
//          quota_limit / upstream_business_error / upstream_unavailable
//   type:  rate_limit_error（429）/ server_error（5xx）
// 文本兜底只认网关自己使用的 WAF 特征词（与其 chat.image.video.js 的 WAF_BODY_RE 同源）。
const IMAGES_BROKEN_CODES = new Set([
    'upstream_waf_challenge',
    'quota_limit',
    'upstream_business_error',
    'upstream_unavailable',
]);
const IMAGES_WAF_TEXT_RE = /upstream_waf_challenge|aliyun_waf|AliyunCaptcha|FAIL_SYS_USER_VALIDATE|RGV587|阿里云\s*WAF|captcha|验证码/i;

function imagesEndpointUnavailable(err) {
    if (!(err instanceof UpstreamError)) return false;
    const status = Number(err.statusCode) || 0;
    if (status === 429 || status >= 500) return true;

    const raw = String(err.body ?? '');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 非 JSON 响应体，走文本兜底 */ }
    const e = (parsed && (parsed.error || parsed)) || null;
    const code = String(e?.code ?? '').trim();
    const type = String(e?.type ?? '').trim();
    if (code && IMAGES_BROKEN_CODES.has(code)) return true;
    if (type === 'rate_limit_error' || type === 'server_error') return true;

    return IMAGES_WAF_TEXT_RE.test(raw.slice(0, 4096));
}

// shouldTryChat 标准生图失败后是否值得转聊天兜底（与 Go 版判定一致）。
function shouldTryChat(err) {
    if (err instanceof NotImageError) return true;
    if (err instanceof UpstreamError) {
        if ([401, 402, 403].includes(err.statusCode)) return false;
        return true;
    }
    return false;
}

// transientErr 瞬时故障判定。
function transientErr(err) {
    if (!err) return false;
    const msg = String(err.message ?? err).toLowerCase();
    return msg.includes('502') || msg.includes('429') ||
        msg.includes('timeout') || msg.includes('超时') ||
        msg.includes('upstream');
}

// sizeRelated 上游错误是否与尺寸有关（用于回退默认尺寸重试）。
function sizeRelated(body) {
    const low = String(body ?? '').toLowerCase();
    return ['size', 'resolution', 'width', 'height', '尺寸', '分辨率'].some(k => low.includes(k));
}

// snippet 压缩空白并截断，用于错误信息里带一小段上游响应。
function snippet(raw, n) {
    const s = String(raw ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!s) return '（空响应）';
    return truncate(s, n);
}

// truncate 按字符数截断（中文安全），超长加 …。
export function truncate(s, n) {
    s = String(s ?? '');
    const r = [...s];
    if (r.length <= n) return s;
    return r.slice(0, n).join('') + '…';
}

// mimeForExt 图片扩展名 → MIME（面板测试预览用）。
export function mimeForExt(ext) {
    switch (String(ext ?? '').toLowerCase()) {
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        default: return 'image/png';
    }
}

// ── 通用小工具 ──

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
    return `${s}s`;
}
