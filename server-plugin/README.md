# V.Adapter · 酒馆服务端插件版

将 NovelAI 协议翻译为上游 OpenAI 兼容接口的适配服务，由酒馆托管：
酒馆启动时插件随之启动，酒馆关闭时随之停止，无需单独运行 exe。

```
酒馆里的 V.Canvas 插画插件 ──NovelAI 协议──▶ 本插件（酒馆进程内，独立监听 :8888）
                                              └──OpenAI 兼容──▶ 上游生图 API
```

> 对外的协议面与 Go 原版保持一致：客户端 NovelAI 渠道 URL 仍填写 `http://<IP>:8888`。
> 插件采用独立端口而非挂载在酒馆路由上，原因是酒馆服务端存在 CSRF 防护，
> 第三方客户端直连酒馆插件路由会被 403 拦截，独立端口可规避该限制。

---

## 一、安装与启动

本目录不作为酒馆插件直接使用，而是由 `<SillyTavern>/plugins/V.Adapter/` 下的引导器
按需载入（见仓库根目录的 `bootstrap/index.js`）。分工如下：

| 位置 | 内容 |
|---|---|
| `<SillyTavern>/plugins/V.Adapter/` | 引导器本体（`bootstrap/` 复制过去），一次部署后不再变动 |
| 扩展目录内的 `server-plugin/` | 服务端实现，随扩展一同分发与更新 |
| 引导器目录下的 `data/` | 运行配置与凭据，独立于代码所在位置 |

步骤：

1) 运行仓库根目录的 `install-loader.bat`（Windows）或 `install-loader.sh`（Linux / macOS / Termux）
2) `<SillyTavern>/config.yaml` 里：
       enableServerPlugins: true
       enableServerPluginsAutoUpdate: false      # 可选，省掉启动时对插件目录做 git 检查
3) 重启酒馆
4) 打开 V.Adapter 扩展抽屉，点「启动协议服务」

此后更新服务端实现无需重启酒馆：更新扩展后点抽屉里的「重载实现」即可。

启动成功后：

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:8888/` | **管理面板**（运行总览 / 角色转译 / 生成记录 / 设置中心） |
| `http://127.0.0.1:8888/ai/generate-image` | 生图端点，返回 ZIP |
| `http://127.0.0.1:8000/api/plugins/v-adapter/status` | 酒馆侧的只读状态（能打开就说明引导器被酒馆加载了） |

> ⚠️ **8888 端口同一时刻仅允许一个进程占用。** 若原有的 Go 版 exe 仍在运行，需先关闭，
> 否则插件启动会报 `端口 8888 已被占用`（日志在酒馆控制台，`[V.Adapter]` 前缀）。

---

## 二、两种响应形态：ZIP（协议）与直出图片

`POST /ai/generate-image` **默认回 ZIP** —— 这是 NovelAI 协议的响应格式，
酒馆助手以及任何标准 NAI 客户端都依赖该格式。

但本服务的客户端无需经过该层封装。当客户端声明「只需图片」时，服务端直接返回
PNG/JPEG 字节流，**不打包 ZIP**：

| 客户端行为 | 服务端返回 |
|---|---|
| `Accept: image/*`（且未主动要求 zip） | **`Content-Type: image/png` 直接为图片字节** |
| 查询串带 `?raw=1` | 同上（强制直出） |
| 不发送 `Accept`（等价 `*/*`）、或显式 `application/zip` | `application/zip`（协议格式） |

两种形态均返回同一张图，区别仅在于外层是否封装 ZIP。V.Canvas 插画插件走直出路径，
因此无需解包。

### 扩展参数 `?expand=1`（输入扩写）

在 `POST /ai/generate-image` 上加查询串 `expand=1` 时，服务端会先把请求里的 `input`
交给已配置的聊天模型，扩写为完整的自然语言画面提示词，再用扩写结果出图。

用途：供 V.Canvas 的「转译出图」页等**由一句简短描述发起出图**的入口使用 ——
调用方无需自行持有聊天模型凭据，也不必直接请求 `/admin/*`（该路径需要面板密码）。

| 项 | 行为 |
|---|---|
| 输出 | `input` → `lib/translate.js`（角色转译，与面板同一条链路）→ 扩写后的提示词 |
| 负面词 | 扩写返回的负面词并入请求自带的负面词 |
| 尺寸 | 请求未显式给出宽高（缺失或 < 16）时，采用扩写推荐的尺寸；显式给出时以请求为准 |
| 失败兜底 | 扩写请求失败 / 超时 / 返回为空 / 长度异常（超过原输入 5 倍且大于 400 字符）→ **回退为原样送出 `input`，不阻断出图** |
| 可观测性 | 每次扩写在生成记录中留一条 `expand` 条目（成功或失败均记录）；回退时响应头 `X-Illust-Expand` 为 `fallback` |
| 响应头 | `X-Illust-Via`（实际链路）、`X-Illust-Prompt`（实际送入上游的提示词，URL 编码）、`X-Illust-Expand`（`ok` / `fallback`） |

标准 NAI 客户端不会带该参数，也不会读取这些响应头，因此协议兼容性不受影响。

## 三、配置

两层，优先级从低到高：

| 文件 | 作用 |
|---|---|
| `data/config.json` | **启动默认值**（首次部署填这里） |
| `data/settings.json` | 面板改动落盘的位置（面板改过之后以其为准） |

```json
{
  "listen": "0.0.0.0:8888",
  "qwen_url": "http://127.0.0.1:4000/v1",
  "qwen_key": "你的上游密钥",
  "qwen_model": "qwen3.8-max",
  "default_size": "1024x1024",
  "nai_key": "v-adapter-8888",
  "chat_fallback": "chat_only"
}
```

也支持环境变量（优先级在两者之间）：
`VADAPTER_QWEN_URL` / `OPENAI_BASE_URL`、`VADAPTER_QWEN_KEY` / `OPENAI_API_KEY`、
`VADAPTER_QWEN_MODEL` / `OPENAI_IMAGE_MODEL`、`VADAPTER_LISTEN`、`VADAPTER_DEFAULT_SIZE`、`VADAPTER_NAI_KEY`。

**恢复 `config.json` 的配置**：删除 `data/settings.json` 并重启酒馆。

### 关键配置项

| 字段 | 建议值 | 说明 |
|---|---|---|
| `chat_fallback` | `chat_only` | 仅使用聊天接口出图。上游标准生图接口 `/images/generations` 稳定返回 500，尝试该接口无效 |
| `qwen_model` | `qwen3.8-max` | 必须为**聊天模型**（在聊天中生成图片并返回图片链接）。不支持 `-image` 后缀的模型 |
| `nai_key` | `v-adapter-8888` | 插画插件中的「API Key」需与此处一致。清空表示放行任意 key |
| `listen` | `0.0.0.0:8888` | 本机为 127.0.0.1:8888；`0.0.0.0` 用于支持手机客户端连接。修改后需重启酒馆 |

### 客户端（V.Canvas 插件）填什么

| 字段 | 填 |
|---|---|
| NAI 服务地址 | `http://127.0.0.1:8888` |
| API Key | `v-adapter-8888` |
| 模型名 | 留空（本服务会忽略客户端传来的模型名） |

插件出厂默认值即如上，一般无需修改。

---

## 四、管理面板登录

- **首次打开免密**，面板会提示设置密码（也可跳过，稍后在「设置中心」补）。
- 设置密码后，`/admin/*` 需要登录；**`/ai/*` 生图端点不受影响**（客户端使用 `nai_key`，与面板登录无关）。
- 密码以 SHA-256 存储于 `data/auth.json`，会话为内存 cookie，24 小时过期。

---

## 五、文件结构

```
V.Adapter/
├── index.js            插件入口：info / init(router) / exit()（酒馆 server plugin 约定）
├── package.json        必须包含 "type": "module" —— plugins/package.json 为 commonjs，
│                         未覆盖时 index.js 会被 Node 当作 CJS 加载，直接报 SyntaxError
├── panel.html          管理面板（原版界面）
├── lib/
│   ├── server.js       内嵌 HTTP 服务（组装路由 + CORS + 面板注入）
│   ├── admin.js        管理端点 + 面板登录
│   ├── nai.js          NovelAI 协议端点（收 NAI 格式、回 ZIP）
│   ├── pipeline.js     上游调用（b64/url 双路、聊天兜底、熔断）
│   ├── translate.js    角色转译
│   ├── watermark.js    去水印（使用酒馆自带的 Jimp）
│   ├── zip.js          手写 store 型 ZIP 打包
│   ├── settings.js     设置读写（data/config.json + 环境变量 + data/settings.json）
│   └── genlog.js       生成记录（内存环形缓冲，最近 200 条）
└── data/               运行时生成（config.json / settings.json / auth.json）
```

### 本轮补全内容

`方案说明.md` 中原标记为待补的两个文件已完成，另修复两处原有代码的断链：

| 文件 | 状态 |
|---|---|
| `lib/server.js` | 新写（内嵌 :8888 HTTP 服务、CORS 预检、面板 HTML 注入 API 桥接），已完成 |
| `lib/admin.js` | 新写（admin.go + auth.go + handleAdminSettings 的 1:1 移植），已完成 |
| `package.json` | 新增（`"type": "module"`，否则插件无法加载，见上） |
| `lib/pipeline.js` | 修复：补充 `import { settingsGet }`（`targetFromSettings` 中调用但未导入） |
| `lib/translate.js` | 修复：`postJSONBridge` → `postJSON`（函数名笔误，与导入名不一致） |

> 面板 `panel.html` 未作修改。其原本走 `window.parent.__V_ADAPTER_API__`（扩展形态的桥接），
> 服务端形态由 `server.js` 在返回 HTML 时注入同名桥接，改走真正的 HTTP。

---

## 六、验收记录（酒馆 1.18.0 环境）

| 检查 | 结果 |
|---|---|
| 酒馆启动后 8888 是否监听 | 是 |
| `GET /health` | 200 `{"status":"ok","version":"v1.1.4-st.1"}` |
| `GET /ai/user/subscription`（带 Bearer） | 200 `{"tier":0,"active":true}` |
| `GET /admin/status` | 200，配置正确 |
| `GET /api/plugins/v-adapter/status`（酒馆侧） | 200 → 插件已被酒馆加载 |
| `GET /` 面板 | 200，已注入 API 桥接 |
| `GET/POST /admin/settings` | 200 |
| CORS 预检 `OPTIONS /ai/generate-image` | 204 + `Allow-Origin: *` + `Allow-Headers: Authorization, Content-Type, Accept` |
| 错误 key 调用生图 | 401 + 提示信息 |
| **端到端出图（ZIP 协议面）** | 20.2 秒 → 2.73 MB ZIP，内含 `image_0.png` |
| **端到端出图（直出图片）** | 21.8 秒 → `Content-Type: image/png`，2.57 MB 裸 PNG，无 ZIP 封装 |
| 老客户端 `Accept: */*` | 仍回 ZIP，协议面未被破坏 |
| 生成记录 | counters `{success:1, fail:0, total:1}`，`via: chat` |
| `exit()`（酒馆退出） | 正常关闭端口 |

样张：仓库根目录的 `plugins-test-output.png`。

### ⚠️ 两个已知限制

1. **出图尺寸不受控。** 聊天链路为"让模型在聊天中生成一张图"，其忽略 `width`/`height`：
   请求 832×1216，实际返回 1664×928。插件中的「分辨率」对本链路基本无效。
2. **偶发失败属正常现象。** 上游为反代网页版，偶尔返回无法下载的图片链接
   （`502` + "聊天生图返回的图片链接均无法下载或解析"），重试一次通常即可恢复；
   pipeline 亦会对瞬时故障自动重试一次。

---

## 七、许可证

MIT License + 非商用附加条款（见根目录 `LICENSE`），作者 VILK。
禁止商用；二次创作/再分发请保留署名与本许可声明。
