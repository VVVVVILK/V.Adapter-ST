// index.js — V.Adapter 服务端引导器（部署位置 <SillyTavern>/plugins/V.Adapter/）。
//
// 酒馆存在两条平台限制：服务端插件只在进程启动时加载一次，且不提供任何安装入口。
// 本文件的作用是把这两条限制隔离掉 —— 它自身不含业务逻辑，也不随版本变化，
// 只在酒馆进程内按需加载 extensions/<扩展目录>/server-plugin/ 下的真实实现。
//
// 由此得到的效果：
//   - 服务端实现随扩展一同分发，经「安装扩展」拉取后无需再复制插件代码；
//   - 实现更新后重新加载即可生效，不必重启酒馆进程；
//   - 运行数据保留在 plugins/V.Adapter/data/，与代码所在位置解耦。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'NovelAI 协议适配服务引导器：按需加载 V.Adapter 扩展内的服务端实现。',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, 'data');

let impl = null;
let busy = false;

// safeReaddir 读取目录项；不可读时返回空数组。
function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

// candidateRoots 列出可能存放扩展的目录。
// 请求上下文可用时优先用它；自动启动阶段没有请求，退回到进程工作目录下的 data/<用户>/extensions。
function candidateRoots(req) {
    const roots = [];
    const fromRequest = String(req?.user?.directories?.extensions ?? '');
    if (fromRequest) roots.push(fromRequest);

    const fromEnv = String(process.env.VADAPTER_EXT_DIR ?? '');
    if (fromEnv) roots.push(fromEnv);

    const usersData = path.join(process.cwd(), 'data');
    for (const entry of safeReaddir(usersData)) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(usersData, entry.name, 'extensions');
        if (fs.existsSync(candidate)) roots.push(candidate);
    }
    return roots;
}

// findImplFile 查找 server-plugin/index.js。
// 扩展目录名取自仓库名，此处逐层扫描以兼容不同命名。
function findImplFile(req) {
    for (const root of candidateRoots(req)) {
        if (!root || !fs.existsSync(root)) continue;
        for (const entry of safeReaddir(root)) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(root, entry.name, 'server-plugin', 'index.js');
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return '';
}

// loadImpl 动态载入服务端实现。
// URL 上附加时间戳用于绕过 ESM 模块缓存，使更新后的代码在同一次运行中立即可用。
async function loadImpl(file) {
    process.env.VADAPTER_DATA_DIR = DATA_DIR;
    return await import(pathToFileURL(file).href + '?v=' + Date.now());
}

// statusOf 读取实现上报的运行状态；实现尚未载入时按停止处理。
function statusOf(req) {
    const file = findImplFile(req);
    const base = {
        installed: Boolean(file),
        implFile: file,
        dataDir: DATA_DIR,
        running: false,
        listen: '',
        version: '',
    };
    if (!impl || typeof impl.getAdapterStatus !== 'function') return base;
    try {
        const st = impl.getAdapterStatus() || {};
        return {
            ...base,
            running: Boolean(st.running),
            listen: st.listen || '',
            version: st.version || '',
            upstream: st.upstream || '',
            model: st.model || '',
        };
    } catch {
        return base;
    }
}

async function startImpl(req) {
    const file = findImplFile(req);
    if (!file) throw new Error('扩展目录下未找到 server-plugin/index.js');
    impl = await loadImpl(file);
    await impl.init(null);
    return statusOf(req);
}

async function stopImpl(req) {
    if (impl && typeof impl.exit === 'function') {
        await impl.exit();
    }
    impl = null;
    return statusOf(req);
}

export async function init(router) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    router.get('/status', (req, res) => {
        res.json({ ok: true, ...statusOf(req) });
    });

    router.post('/start', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: '上一个操作尚未结束' });
        busy = true;
        try {
            if (statusOf(req).running) {
                return res.json({ ok: true, already: true, ...statusOf(req) });
            }
            const st = await startImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            impl = null;
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    router.post('/stop', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: '上一个操作尚未结束' });
        busy = true;
        try {
            const st = await stopImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    // reload 用于载入更新后的实现：先释放端口与资源，再读取同一路径上的新代码。
    router.post('/reload', async (req, res) => {
        if (busy) return res.status(409).json({ ok: false, error: '上一个操作尚未结束' });
        busy = true;
        try {
            await stopImpl(req);
            const st = await startImpl(req);
            res.json({ ok: true, ...st });
        } catch (err) {
            impl = null;
            res.status(500).json({ ok: false, error: String(err?.message ?? err) });
        } finally {
            busy = false;
        }
    });

    await autoStart();
}

// autoStart 在酒馆启动时尝试拉起协议服务，使服务端行为与常规插件一致：
// 重启后无需人工干预即可对外提供 :8888。
// 失败不阻断酒馆启动，此时抽屉显示服务不可用，由使用者处理。
// 设置 VADAPTER_AUTOSTART=0 可关闭该行为，改为完全手动启停。
async function autoStart() {
    if (String(process.env.VADAPTER_AUTOSTART ?? '1') === '0') return;
    try {
        await startImpl({});
        console.info('[V.Adapter] 协议服务已随酒馆启动');
    } catch (err) {
        console.warn(`[V.Adapter] 协议服务未随酒馆启动：${err?.message ?? err}`);
    }
}

/** 酒馆退出时释放端口与资源。 */
export async function exit() {
    await stopImpl({});
}
