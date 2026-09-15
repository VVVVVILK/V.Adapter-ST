// index.js — V.Adapter 酒馆服务端插件入口（NovelAI 协议适配）。
//
// 与 V.Adapter（Go）v1.1.4 的关系：本插件将该独立服务交由酒馆托管启动。
//   - 对外保持完整的 NovelAI 协议面（/ai/generate-image 收 NAI 格式、回 ZIP；
//     /ai/user/subscription；/ai/encode-vibe 404）；
//   - 内置独立监听端口（默认 8888，可在管理面板修改），沿用原服务的对接方式，
//     客户端 NovelAI 渠道 URL 无需修改，同时规避酒馆服务端的 CSRF 防护；
//   - 无需单独运行 exe，随酒馆启动 / 退出；管理面板 1:1 保留。
//
// 安装：本文件不直接作为酒馆插件使用。它由 `<SillyTavern>/plugins/V.Adapter/` 下的
//       引导器按需载入（见仓库根目录的 `bootstrap/index.js`），因此服务端实现可以跟随
//       扩展一同分发与更新。运行数据落在引导器所在目录的 `data/`，与此处的位置无关。

import { startAdapterService, stopAdapterService, getAdapterStatus } from './lib/server.js';

export const info = {
    id: 'v-adapter',
    name: 'V.Adapter',
    description: 'NovelAI 协议适配：把上游 OpenAI 兼容生图 API 包装成 NovelAI 协议服务（端口 8888，自带管理面板）。',
};

/**
 * 插件初始化（酒馆 server plugin 入口）。
 * @param {import('express').Router} router 挂载在 /api/plugins/v-adapter 下的路由（本插件主服务走独立端口）
 */
export async function init(router) {
    await startAdapterService();

    // 顺带在酒馆自己的路由上暴露一个只读状态端点，方便从酒馆层面查看运行情况
    if (router && typeof router.get === 'function') {
        router.get('/status', (req, res) => {
            res.json(getAdapterStatus());
        });
    }
}

/** 插件退出（酒馆关闭时调用）：停掉内嵌服务。 */
export async function exit() {
    await stopAdapterService();
}

// 向外暴露运行状态，供酒馆内的服务端引导器查询（引导器不直接依赖 lib/ 下的实现）。
export { getAdapterStatus };
