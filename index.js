// index.js — V.Adapter 酒馆扩展入口。
// 移植自 V.Adapter（Go）v1.1.4：扩展自己就是出图引擎（上游对接 / 聊天兜底 /
// 熔断 / 去水印 / 角色转译 / 生成记录 / 管理面板），装上即可出图。
// 对应关系：Go 版 handleGenerateImage 主体 → 本文件 runGeneration()；
// 管理面板端点 → lib/virtual-api.js；面板 UI → panel.html。
//
// 职责边界：本扩展为引擎与指挥层，负责「怎么画」（上游对接、协议转换、
//           去水印、生成记录、8888 协议端口）。监听 AI 回复自动出图属呈现层的职责，
//           由 V.Canvas 承担，本扩展不参与。
//
// 画风：本扩展不再提供画风预设。画风统一由消费方（V.Canvas 的「提示词」页、
//       第三方的生图插件）自行决定，经 :8888 转发的请求按客户端给的 input 原样送出。

import { eventSource, event_types, systemUserName, getRequestHeaders } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { saveBase64AsFile } from '/scripts/utils.js';
import { getMessageTimeStamp } from '/scripts/RossAscends-mods.js';
import { MEDIA_TYPE, MEDIA_SOURCE, MEDIA_DISPLAY } from '/scripts/constants.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '/scripts/slash-commands/SlashCommandArgument.js';

import { initSettings, bindResetImagesBroken, settingsGet, normalizeSizeStr } from './lib/settings.js';
import { genLog, newRecord } from './lib/genlog.js';
import { generateImage, resetImagesBroken, truncate, bytesToBase64, logf } from './lib/pipeline.js';
import { translateCharacter } from './lib/translate.js';
import { handleApi } from './lib/virtual-api.js';

// 设置命名空间（保持小写标识，作为 extension_settings 的存储键，不随显示名变化）。
export const MODULE_NAME = 'v-adapter';
const version = 'v1.1.5-st.1';

// ── 初始化 ──
export async function init() {
    initSettings();
    bindResetImagesBroken(resetImagesBroken);

    addSettingsUI();
    registerSlashCommand();
    logf(`已加载（${version}）：扩展自身即出图引擎，装上即可用`);
}

export async function exit() {
    $(`#v_adapter_drawer`).remove();
    $('#v_adapter_panel_overlay').remove();
}

// ── 出图主链路（对应 Go 版 handleGenerateImage 主体）──

// runGeneration 生成一张图并记录。
//   prompt       正向提示词（必填）
//   neg          负向提示词（可空；管线在标准接口失败时自动降级去掉）
//   size         "宽x高"（可空 = 用默认尺寸）
// 返回 { result } 或抛出异常（错误信息均为面向用户的可读文本）。
async function runGeneration(prompt, neg, size) {
    const start = Date.now();
    prompt = String(prompt ?? '').trim();
    neg = String(neg ?? '').trim();

    // 尺寸：默认尺寸兜底，clamp 64..2048（与 Go 版 NAI 端点一致）
    const defWH = parseWH(settingsGet.defaultSize());
    let width = defWH.w, height = defWH.h;
    const given = normalizeSizeStr(size);
    if (given) {
        const g = parseWH(given);
        width = Math.min(2048, Math.max(64, g.w));
        height = Math.min(2048, Math.max(64, g.h));
    }
    size = `${width}x${height}`;

    const target = {
        url: settingsGet.qwenURL(),
        key: settingsGet.qwenKey(),
        model: settingsGet.qwenModel(),
        defaultSize: settingsGet.defaultSize(),
    };
    const rec = newRecord({
        kind: 'generate', endpoint: '/ai/generate-image', model: target.model,
        prompt: truncate(prompt, 80), size,
    });

    if (!prompt) {
        rec.status = 400;
        rec.error = '正向提示词（input）为空';
        genLog.Add(rec);
        throw new Error('正向提示词（input）为空，客户端未拼出正向词');
    }

    logf(`[Gen] 生图请求 size=${size} 负向词=${[...neg].length}字 正向词=${[...prompt].length}字`);

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
        logf(`[Gen] 生图失败（${rec.latency_ms}ms）：${gerr.message}`);
        throw gerr;
    }
    rec.ok = true;
    rec.status = 200;
    rec.via = result.via;
    genLog.Add(rec);
    logf(`[Gen] 生图成功（${rec.latency_ms}ms via ${result.via}）：${size} ${result.ext} ${Math.floor((result.data?.length ?? 0) / 1024)}KB`);
    return result;
}

function parseWH(s) {
    const [w, h] = String(s ?? '1024x1024').split('x').map(v => parseInt(v, 10) || 0);
    return { w: w > 0 ? w : 1024, h: h > 0 ? h : 1024 };
}

// ── 出图结果进聊天（官方媒体消息姿势，与酒馆 sd 扩展一致）──

async function deliverToChat(result, title) {
    const context = getContext();
    const name = context.groupId ? systemUserName : context.name2;

    let url;
    if (result.data) {
        const b64 = bytesToBase64(result.data);
        const filename = `${name}_${Date.now()}`;
        url = await saveBase64AsFile(b64, name, filename, result.ext);
    } else if (result.remoteUrl) {
        url = result.remoteUrl; // CORS 降级：直接引用远程图（浏览器展示无需跨域）
    } else {
        throw new Error('生图结果为空');
    }

    const message = {
        name: name,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: title ?? '',
        extra: {
            media: [{
                url: url,
                type: MEDIA_TYPE.IMAGE,
                title: title ?? '',
                source: MEDIA_SOURCE.GENERATED,
            }],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    try { context.scrollOnMediaLoad?.(); } catch { /* 旧版本无此方法 */ }
    return url;
}

// 生成并投递（/vgen、抽屉、自动出图共用）。
async function generateAndDeliver({ text, translate = false, size = '' }) {
    if (!text || !text.trim()) {
        toastr.error('请输入提示词或描述', 'V.Adapter');
        return;
    }
    let prompt = text.trim();
    let neg = '';
    if (translate) {
        toastr.info('正在转译描述 …', 'V.Adapter');
        const target = {
            url: settingsGet.qwenURL(),
            key: settingsGet.qwenKey(),
            model: settingsGet.qwenModel(),
        };
        const r = await translateCharacter(target, prompt);
        prompt = r.prompt;
        neg = r.negative_prompt;
        if (size === '') size = `${r.width}x${r.height}`;
    }
    toastr.info('正在生成图片，请稍候（单张约 30~60s）…', 'V.Adapter');
    const result = await runGeneration(prompt, neg, size);
    await deliverToChat(result, truncate(prompt, 100));
    toastr.success(`出图完成（链路 ${result.via}）`, 'V.Adapter');
}

// ── /vgen 命令 ──

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vgen',
        callback: async (namedArgs, unnamedArgs) => {
            const text = String(unnamedArgs ?? '').trim();
            const translate = !(namedArgs.translate === 'false');
            const size = namedArgs.size ?? '';
            try {
                await generateAndDeliver({ text, translate, size });
            } catch (err) {
                toastr.error(String(err?.message ?? err), 'V.Adapter 出图失败', { timeout: 10000 });
            }
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'translate',
                description: '先把内容当描述转译成提示词（默认 true）；false = 直接把内容当提示词出图',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'size',
                description: '图片尺寸（宽x高，如 832x1216）；默认用设置中心的默认尺寸',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: '提示词或描述（translate=true 时为自然语言描述）',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                用 V.Adapter（上游 OpenAI 兼容生图）生成一张图片并发送到聊天。<br />
                例：/vgen 一只橘猫趴在窗台上晒太阳 &nbsp;&nbsp; /vgen translate=false size=832x1216 1girl, silver hair, school uniform
            </div>
        `,
    }));
}

// ── 管理面板弹窗（panel.html 1:1 保留，经桥接调用内置端点）──
//
// 以 iframe 内嵌方式打开：不走 window.open，避免手机端弹窗拦截。
// 面板地址用真实 URL（src），不用 srcdoc —— 后者在部分手机浏览器与应用内
// WebView 中被限制，会导致面板内容空白。浮层高度由 CSS 的 100vh 兜底、
// 并由 bindPanelFit 按可视视口赋精确像素值，内嵌失败时给出提示并提供新标签页入口。

let panelFitHandler = null;

// 浮层高度按可视视口精确赋值：移动端浏览器地址栏收起/展开、横竖屏切换都会改变可视高度。
function fitPanelHeight(el) {
    const h = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight || 0);
    if (h > 0) el.style.height = h + 'px';
}

function bindPanelFit(el) {
    panelFitHandler = () => fitPanelHeight(el);
    fitPanelHeight(el);
    window.addEventListener('resize', panelFitHandler);
    window.addEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', panelFitHandler);
}

function unbindPanelFit() {
    if (!panelFitHandler) return;
    window.removeEventListener('resize', panelFitHandler);
    window.removeEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', panelFitHandler);
    panelFitHandler = null;
}

async function openPanel() {
    closePanel();
    const overlay = $(`
        <div id="v_adapter_panel_overlay">
            <div class="v_adapter_panel_chrome">
                <span>V.Adapter 管理面板</span>
                <div class="v_adapter_panel_actions">
                    <button class="menu_button" id="v_adapter_panel_newtab">新标签页</button>
                    <button class="menu_button" id="v_adapter_panel_close">关闭</button>
                </div>
            </div>
            <iframe id="v_adapter_panel_iframe" title="V.Adapter 管理面板"></iframe>
            <div id="v_adapter_panel_fallback">
                <div class="v_adapter_panel_fallback_card">
                    <b>面板未能内嵌显示</b>
                    <p>当前浏览环境可能禁止内嵌页面（部分手机浏览器与应用内 WebView 会限制 iframe）。
                       改用新标签页打开面板，功能与内嵌方式一致。</p>
                    <button class="menu_button" id="v_adapter_panel_fallback_open">在新标签页打开面板</button>
                </div>
            </div>
        </div>`);
    $('body').append(overlay);
    bindPanelFit(overlay[0]);

    // 桥接：__V_ADAPTER_API__ → 面板的 /admin/* 端点（设置中心 / 画风 / 转译 / 记录）。
    window.__V_ADAPTER_API__ = handleApi;

    const url = new URL('./panel.html', import.meta.url).href + '?v=' + encodeURIComponent(version);
    const frame = overlay.find('#v_adapter_panel_iframe')[0];

    // 新标签页入口：面板页会改从 window.opener 取桥接函数，因此同样可用。
    const openInNewTab = () => {
        const w = window.open(url, '_blank');
        if (!w) overlay.find('#v_adapter_panel_fallback').addClass('show');
    };

    let loaded = false;
    frame.addEventListener('load', () => {
        // 未设置 src 时也会触发一次 load（about:blank），据 body 是否为空区分。
        try {
            const doc = frame.contentDocument;
            if (doc && doc.body && doc.body.childElementCount > 0) loaded = true;
        } catch {
            loaded = true; // 跨域无法读取内容时视为已加载
        }
    });
    frame.src = url;

    overlay.find('#v_adapter_panel_close').on('click', closePanel);
    overlay.find('#v_adapter_panel_newtab').on('click', openInNewTab);
    overlay.find('#v_adapter_panel_fallback_open').on('click', openInNewTab);

    setTimeout(() => {
        if (!loaded && document.body.contains(frame)) {
            overlay.find('#v_adapter_panel_fallback').addClass('show');
        }
    }, 8000);
}

function closePanel() {
    $('#v_adapter_panel_overlay').remove();
    unbindPanelFit();
    try { delete window.__V_ADAPTER_API__; } catch { /* 忽略 */ }
}


// ── 页面内调用桥：供同一酒馆页面内的其他扩展直接调用 ──
//
// V.Canvas 与本扩展通常装在同一个酒馆实例里，二者处于同一个页面上下文，
// 因此可以直接以函数调用完成 NAI 协议的请求与应答：不需要监听端口，
// 也不需要把服务端实现部署到 <SillyTavern>/plugins/ 下，更不需要重启酒馆。
// 由此，两个扩展在任意酒馆（本机 / 服务器 / 移动端）安装后即可使用。
//
// 入参：标准 NAI 请求体；第二参数 { expand } 表示是否先做提示词扩写。
// 返回：{ status, contentType, bytes }；失败时为 { status, error }。
// 语义与 HTTP 响应一致，调用方按同一套分支处理即可。

window.__V_ADAPTER_NAI__ = async function (naiBody, options) {
    try {
        const p = naiBody?.parameters ?? {};
        let prompt = String(naiBody?.input ?? '').trim();
        let neg = String(p.negative_prompt ?? '').trim();
        const w = Number(p.width) || 0;
        const h = Number(p.height) || 0;
        let size = (w > 0 && h > 0) ? `${w}x${h}` : '';

        if (options?.expand) {
            const target = {
                url: settingsGet.qwenURL(),
                key: settingsGet.qwenKey(),
                model: settingsGet.qwenModel(),
            };
            const t = await translateCharacter(target, prompt);
            prompt = t.prompt;
            neg = t.negative_prompt;
            if (size === '') size = `${t.width}x${t.height}`;
        }

        const r = await runGeneration(prompt, neg, size);
        // CORS 降级结果：上游只给出远程链接、浏览器侧因跨域下载不到字节。
        // 此时把链接经 url 字段原样交回调用方，由调用方直接引用远程图；
        // 若不区分，调用方会把「无字节的成功结果」误判为失败。
        if (!r.data && r.remoteUrl) {
            return {
                status: 200,
                contentType: `image/${r.ext === 'jpg' ? 'jpeg' : r.ext}`,
                bytes: null,
                url: r.remoteUrl,
                via: r.via,
            };
        }
        return {
            status: 200,
            contentType: `image/${r.ext === 'jpg' ? 'jpeg' : r.ext}`,
            bytes: r.data,
            via: r.via,
        };
    } catch (err) {
        return {
            status: 502,
            contentType: 'application/json',
            error: String(err?.message ?? err),
        };
    }
};

// ── 扩展抽屉 UI（协议服务启停 + 名称 + 版本 + 打开管理面板）──
//
// 抽屉只保留服务开关这类一步到位的动作。参数类功能仍在管理面板（panel.html）里，
// 避免抽屉版式过长。

function addSettingsUI() {
    const html = `
    <div id="v_adapter_drawer" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>V.Adapter <span class="v_adapter_version">${version}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content v_adapter_content">
                <div class="v_adapter_row v_adapter_svc">
                    <span class="v_adapter_svc_label">出图引擎</span>
                    <span id="v_adapter_svc_state" class="v_adapter_svc_state v_adapter_svc_on">就绪</span>
                </div>
                <div id="v_adapter_svc_block" class="v_adapter_svc_block">
                    <div class="v_adapter_row v_adapter_svc">
                        <span class="v_adapter_svc_label">协议服务</span>
                        <span id="v_adapter_svc_detail" class="v_adapter_svc_state">—</span>
                    </div>
                    <div class="v_adapter_row">
                        <button id="v_adapter_svc_toggle" class="menu_button">
                            <i class="fa-solid fa-power-off"></i><span>启动协议服务</span>
                        </button>
                    </div>
                    <div class="v_adapter_row">
                        <button id="v_adapter_svc_reload" class="menu_button"
                                title="更新过插件文件后点这里即可生效，不必重启酒馆">
                            <i class="fa-solid fa-rotate"></i><span>应用更新</span>
                        </button>
                    </div>
                    <div id="v_adapter_svc_hint" class="v_adapter_row v_adapter_svc_hint">
                        <small>协议服务为<b>可选</b>能力：仅供柏宝绘这类第三方 NAI 客户端连接。
                        V.Canvas 默认走页面内直连，无需启动本服务。</small>
                    </div>
                </div>
                <div class="v_adapter_row">
                    <button id="v_adapter_open_panel" class="menu_button">
                        <i class="fa-solid fa-sliders"></i><span>打开管理面板</span>
                    </button>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    $('#v_adapter_open_panel').on('click', openPanel);
    $('#v_adapter_svc_toggle').on('click', onServiceToggle);
    $('#v_adapter_svc_reload').on('click', onServiceReload);

    // 抽屉展开时刷新一次，避免展示上一次会话留下的状态。
    $('#v_adapter_drawer .inline-drawer-toggle').on('click', refreshServiceState);
    refreshServiceState();
}

// ── 协议服务的启停 ──
//
// 服务端实现位于扩展目录内的 server-plugin/，由 <SillyTavern>/plugins/V.Adapter/ 下的
// 引导器按需载入。这里只负责调用引导器暴露的三个端点。
//
//   GET  /status   查询实现是否存在、是否在运行
//   POST /start    载入实现并监听端口
//   POST /stop     释放端口与资源
//   POST /reload   先 stop 再 start，用于载入更新后的实现

const SVC_API = '/api/plugins/v-adapter';

// serviceRequest 调用引导器端点；网络或业务失败统一抛可读错误。
async function serviceRequest(action) {
    const res = await fetch(`${SVC_API}/${action}`, {
        method: action === 'status' ? 'GET' : 'POST',
        headers: getRequestHeaders(),
    });
    let data = {};
    try {
        data = await res.json();
    } catch {
        if (!res.ok) throw new Error(`HTTP ${res.status}：引导器未安装`);
    }
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

// toastError 展示错误；提示组件缺失时静默降级。
function toastError(msg) {
    try {
        toastr.error(msg, 'V.Adapter', { timeOut: 5000, preventDuplicates: true });
    } catch {
        console.error('[V.Adapter]', msg);
    }
}

// renderServiceState 按引导器的返回刷新抽屉。
//
// 协议服务属于可选能力（供同网络的第三方 NAI 客户端使用），主出图通道是页面内直连。
// 未部署引导器时该块仍显示但置灰，并给出部署指引——隐藏会让需要该功能的人找不到入口。
function renderServiceState(st) {
    const block = $('#v_adapter_svc_block');
    const detail = $('#v_adapter_svc_detail');
    const toggle = $('#v_adapter_svc_toggle');
    const reload = $('#v_adapter_svc_reload');
    const hint = $('#v_adapter_svc_hint');
    if (!block.length) return;

    block.show();

    if (!st || !st.installed) {
        detail.text('未部署（可选）').removeClass('v_adapter_svc_on').addClass('v_adapter_svc_off');
        toggle.prop('disabled', true).find('span').text('启动协议服务');
        reload.prop('disabled', true);
        if (hint.length) {
            hint.html('<small>协议服务为<b>可选</b>能力：仅供柏宝绘这类第三方 NAI 客户端连接；' +
                'V.Canvas 默认走页面内直连，无需本服务。<br>' +
                '如需启用：运行扩展目录下的 <code>install-loader</code>，' +
                '在 <code>config.yaml</code> 设置 <code>enableServerPlugins: true</code>，然后重启酒馆。</small>');
        }
        return;
    }

    toggle.prop('disabled', false);
    reload.prop('disabled', !st.running);

    if (st.running) {
        detail.text(st.listen ? `运行中 · ${st.listen}` : '运行中')
            .removeClass('v_adapter_svc_off').addClass('v_adapter_svc_on');
        toggle.find('span').text('停止协议服务');
        toggle.find('i').removeClass('fa-power-off').addClass('fa-stop');
        if (hint.length) {
            hint.html('<small>第三方 NAI 客户端请填写 <code>' +
                String(st.listen ?? '').replace(/^0\.0\.0\.0/, '127.0.0.1') +
                '</code>，Key 与服务端 <code>nai_key</code> 一致。' +
                '更新插件文件后点「应用更新」生效，不必重启酒馆。</small>');
        }
    } else {
        detail.text('已停止').removeClass('v_adapter_svc_on').addClass('v_adapter_svc_off');
        toggle.find('span').text('启动协议服务');
        toggle.find('i').removeClass('fa-stop').addClass('fa-power-off');
        if (hint.length) {
            hint.html('<small>协议服务为<b>可选</b>能力：启动后第三方 NAI 客户端才能连接；' +
                '仅用 V.Canvas 时无需启动。</small>');
        }
    }
}

async function refreshServiceState() {
    try {
        renderServiceState(await serviceRequest('status'));
    } catch (err) {
        renderServiceState(null);
        console.warn('[V.Adapter] 协议服务状态读取失败：', err.message);
    }
}

async function onServiceToggle() {
    const btn = $('#v_adapter_svc_toggle');
    const running = $('#v_adapter_svc_state').hasClass('v_adapter_svc_on');
    btn.prop('disabled', true);
    try {
        await serviceRequest(running ? 'stop' : 'start');
        await refreshServiceState();
    } catch (err) {
        toastError(`${running ? '停止' : '启动'}失败：${err.message}`);
        await refreshServiceState();
    }
}

async function onServiceReload() {
    const btn = $('#v_adapter_svc_reload');
    btn.prop('disabled', true);
    try {
        await serviceRequest('reload');
        await refreshServiceState();
    } catch (err) {
        toastError(`重载失败：${err.message}`);
        await refreshServiceState();
    }
}

// ── 自行启动 ──
// SillyTavern 的扩展加载器只负责挂载 <script type="module">，不会调用 init()，
// 因此在模块加载完成后自行初始化（与官方系统扩展行为一致）。
init().catch(err => console.error('[V.Adapter] 初始化失败:', err));
