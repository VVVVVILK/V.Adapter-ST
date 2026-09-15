// watermark.js — 去除生成图右下角的平台水印角标（如 "Qwen"）。
// 1:1 移植自 V.Adapter（Go）watermark.go（Canvas 实现替代 Go image 标准库）：
//
// 背景：聊天接口生图兜底返回的是上游官网生成的图，右下角带 "Qwen" 水印
// （标准生图接口不含此水印，故仅处理 chat 链路）。
// 做法：对右下角固定比例区域做多次均值模糊，抹掉角标文字、保留背景纹理。
// 仅支持 PNG/JPEG；webp/gif/bmp 等格式原样返回（不处理，避免解码失败）。

// 右下角水印区域比例（相对图宽高）。聊天链路水印约占右 11%、下 9%，
// 留足余量保证完整覆盖。
const WM_RIGHT_RATIO = 0.15;
const WM_BOTTOM_RATIO = 0.12;

// removeWatermark 把图片右下角区域做均值模糊；不支持的格式/解码失败返回原字节。
// 输入/输出均为 Uint8Array（图片原始字节）。
export async function removeWatermark(data, ext) {
    let isJPG = false;
    if (ext === 'png') {
        // png
    } else if (ext === 'jpg' || ext === 'jpeg') {
        isJPG = true;
    } else {
        return data;
    }

    let bitmap;
    try {
        bitmap = await decodeToBitmap(data);
    } catch {
        return data; // 解码失败原样返回（与 Go 版一致）
    }
    const w = bitmap.width, h = bitmap.height;
    if (w < 64 || h < 64) return data;

    const x0 = Math.floor(w * (1 - WM_RIGHT_RATIO));
    const y0 = Math.floor(h * (1 - WM_BOTTOM_RATIO));
    const x1 = w, y1 = h;
    if (x0 >= x1 || y0 >= y1) return data;

    // 取整图像素（Canvas 直接给整图 ImageData，处理右下角子区域）
    const ctx = get2dContext(bitmap.source);
    const full = ctx.getImageData(0, 0, w, h);
    const px = full.data; // RGBA，非预乘

    // 迭代均值模糊（9x9 邻域，6 轮），把角标文字彻底抹平、背景纹理保留。
    // 每轮先对区域做快照，从快照读邻居（clamp 到区域边界），写回原图——与 Go 版一致。
    for (let iter = 0; iter < 6; iter++) {
        const snap = new Uint8ClampedArray(px); // 整图快照
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
                px[o] = r / n;
                px[o + 1] = g / n;
                px[o + 2] = b / n;
                px[o + 3] = a / n;
            }
        }
    }
    ctx.putImageData(full, 0, 0);

    const blob = await canvasToBlob(bitmap.source, isJPG);
    const buf = new Uint8Array(await blob.arrayBuffer());
    return buf;
}

// decodeToBitmap 解码字节为可绘制对象（优先 OffscreenCanvas，回退 HTMLCanvasElement）。
async function decodeToBitmap(data) {
    const blob = new Blob([data]);
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return { source: canvas, width: canvas.width, height: canvas.height };
    }
    // 回退路径：HTMLImageElement + 常规 canvas
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('image decode failed'));
            im.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return { source: canvas, width: canvas.width, height: canvas.height };
    } finally {
        URL.revokeObjectURL(url);
    }
}

function get2dContext(source) {
    return source.getContext('2d', { willReadFrequently: true });
}

async function canvasToBlob(source, isJPG) {
    if (typeof OffscreenCanvas === 'function' && source instanceof OffscreenCanvas) {
        return source.convertToBlob(isJPG ? { type: 'image/jpeg', quality: 0.90 } : { type: 'image/png' });
    }
    return new Promise((resolve, reject) => {
        source.toBlob(
            blob => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))),
            isJPG ? 'image/jpeg' : 'image/png',
            isJPG ? 0.90 : undefined,
        );
    });
}
