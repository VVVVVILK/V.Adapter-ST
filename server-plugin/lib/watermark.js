// watermark.js — 去除生成图右下角的平台水印角标（Node 服务端版，Jimp 实现）。
// 1:1 移植自 V.Adapter（Go）watermark.go（Go 用标准库 image，这里用酒馆自带的 Jimp）：
//   仅支持 PNG/JPEG；对右下角固定比例区域做多次均值模糊，抹掉角标文字、保留背景纹理；
//   webp/gif/bmp 等格式原样返回（不处理，避免解码失败）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Jimp 由酒馆提供（<SillyTavern>/src/jimp.js）。写死的相对路径会随本目录在目录树中的
// 深度变化而失效，因此按候选绝对路径探测；探测失败时返回 null，调用方原样返回图片。
let jimpPromise = null;

function loadJimp() {
    if (!jimpPromise) {
        jimpPromise = (async () => {
            const roots = [process.env.VADAPTER_ST_ROOT, process.cwd()].filter(Boolean);
            for (const root of roots) {
                const file = path.join(String(root), 'src', 'jimp.js');
                if (fs.existsSync(file)) return await import(pathToFileURL(file).href);
            }
            return null;
        })();
    }
    return jimpPromise;
}

// 右下角水印区域比例（相对图宽高）。聊天链路水印约占右 11%、下 9%，此处留足余量。
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

/**
 * 把图片右下角区域做均值模糊；不支持的格式/解码失败返回原字节。
 * @param {Uint8Array} data 图片字节
 * @param {string} ext 扩展名（png/jpg/jpeg/webp/gif/bmp）
 * @returns {Promise<Uint8Array>} 处理后的字节（或原字节）
 */
export async function removeWatermark(data, ext) {
    let isJPG = false;
    if (ext === 'png') {
        // png
    } else if (ext === 'jpg' || ext === 'jpeg') {
        isJPG = true;
    } else {
        return data;
    }

    const jimp = await loadJimp();
    if (!jimp) return data; // 酒馆自带的 Jimp 不可用时跳过处理，不影响出图

    let img;
    try {
        img = await jimp.default.fromBuffer(Buffer.from(data));
    } catch {
        return data; // 解码失败原样返回（与 Go 版一致）
    }

    const w = img.bitmap.width, h = img.bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    const px = img.bitmap.data; // RGBA

    // 迭代均值模糊（9x9 邻域，6 轮），把角标文字彻底抹平、背景纹理保留。
    for (let iter = 0; iter < 6; iter++) {
        const snap = Buffer.from(px); // 快照（从快照读邻居，避免本轮内串扰）
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                let r = 0, g = 0, b = 0, a = 0, n = 0;
                for (let dy = -4; dy <= 4; dy++) {
                    let ny = y + dy;
                    if (ny < y0) ny = y0; else if (ny >= y1) ny = y1 - 1;
                    for (let dx = -4; dx <= 4; dx++) {
                        let nx = x + dx;
                        if (nx < x0) nx = x0; else if (nx >= x1) nx = x1 - 1;
                        const idx = (ny * w + nx) * 4;
                        r += snap[idx];
                        g += snap[idx + 1];
                        b += snap[idx + 2];
                        a += snap[idx + 3];
                        n++;
                    }
                }
                const o = (y * w + x) * 4;
                px[o] = Math.round(r / n);
                px[o + 1] = Math.round(g / n);
                px[o + 2] = Math.round(b / n);
                px[o + 3] = Math.round(a / n);
            }
        }
    }

    try {
        const out = isJPG
            ? await img.getBuffer(jimp.JimpMime.jpeg, { quality: 90 })
            : await img.getBuffer(jimp.JimpMime.png);
        return new Uint8Array(out);
    } catch {
        return data;
    }
}
