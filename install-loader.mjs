#!/usr/bin/env node
// install-loader.mjs —— 自动部署 V.Adapter 服务端引导器。
//
// 做三件事，全部自动完成，无需手工编辑任何文件：
//   1) 定位酒馆根目录（默认从本脚本位置向上查找，也可用命令行参数或 ST_ROOT 指定）
//   2) 复制 bootstrap/ 到 <酒馆>/plugins/V.Adapter/
//   3) 将 config.yaml 的 enableServerPlugins 改为 true（原文件自动备份）
//
// 用法：
//   node install-loader.mjs                 // 自动定位
//   node install-loader.mjs /path/to/ST     // 手动指定酒馆根目录
//
// 完成后需重启酒馆一次，之后"协议服务"随酒馆自动启动，不再需要任何配置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bootDir = path.join(here, 'bootstrap');
const PLUGIN_NAME = 'V.Adapter';

const log = (s) => console.log(s);

function isStRoot(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    const hasConfig = fs.existsSync(path.join(dir, 'config.yaml'));
    const hasServer = fs.existsSync(path.join(dir, 'server.js'));
    return hasConfig && hasServer;
}

// 1) 定位酒馆根目录
function findStRoot() {
    const arg = process.argv[2];
    if (arg) {
        const p = path.resolve(arg);
        return isStRoot(p) ? p : null;
    }
    if (process.env.ST_ROOT && isStRoot(process.env.ST_ROOT)) {
        return path.resolve(process.env.ST_ROOT);
    }
    // 本脚本位于 <ST>/data/<user>/extensions/<扩展>/ 时，向上四级即根目录
    let cur = here;
    for (let i = 0; i < 6; i++) {
        cur = path.dirname(cur);
        if (isStRoot(cur)) return cur;
    }
    return null;
}

const stRoot = findStRoot();
if (!stRoot) {
    log('[失败] 没能自动找到酒馆根目录。');
    log('       请手动指定，例如：');
    log('         node install-loader.mjs "C:\\SillyTavern"');
    log('         node install-loader.mjs /root/SillyTavern');
    process.exit(1);
}

log('酒馆目录: ' + stRoot);

// 2) 复制引导器
if (!fs.existsSync(path.join(bootDir, 'index.js'))) {
    log('[失败] 未找到 bootstrap/index.js，请从扩展目录内运行本脚本。');
    process.exit(1);
}

const pluginDir = path.join(stRoot, 'plugins', PLUGIN_NAME);
fs.mkdirSync(path.join(pluginDir, 'data'), { recursive: true });
fs.copyFileSync(path.join(bootDir, 'index.js'), path.join(pluginDir, 'index.js'));
fs.copyFileSync(path.join(bootDir, 'package.json'), path.join(pluginDir, 'package.json'));
log('引导器已安装: ' + pluginDir);

// 3) 开启服务端插件
const cfgPath = path.join(stRoot, 'config.yaml');
let cfg = fs.readFileSync(cfgPath, 'utf8');
const m = cfg.match(/^(\s*enableServerPlugins:\s*)(false|true)\s*$/m);

if (!m) {
    log('[注意] config.yaml 里没有 enableServerPlugins 这一项，已自动追加。');
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/\s*$/, '\n') + '\nenableServerPlugins: true\n';
    fs.writeFileSync(cfgPath, cfg);
    log('已追加 enableServerPlugins: true（备份: ' + bak + '）');
} else if (m[2] === 'true') {
    log('config.yaml 已开启服务端插件，无需改动。');
} else {
    const bak = cfgPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(cfgPath, bak);
    cfg = cfg.replace(/^(\s*enableServerPlugins:\s*)false\s*$/m, '$1true');
    fs.writeFileSync(cfgPath, cfg);
    log('config.yaml 已改为 enableServerPlugins: true（备份: ' + bak + '）');
}

log('');
log('完成。下一步：重启酒馆一次。');
log('重启后，扩展抽屉里的「协议服务」会随酒馆自动启动；');
log('只需要第三方酒馆生图插件时才需要它，V.Canvas 默认走页面内直连。');
