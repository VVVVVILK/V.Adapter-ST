# V.Adapter 服务端引导器

本目录部署到 `<SillyTavern>/plugins/V.Adapter/`，属一次性部署，之后不再随版本变动。

## 解决的问题

酒馆存在两条平台限制：

1. 服务端插件只在进程启动时加载一次（见 `src/plugin-loader.js` 的调用点），运行中放入
   `plugins/` 的目录不会被加载；
2. 不为服务端插件提供安装入口 —— `src/endpoints/` 下没有 `plugins.js`，
   `/api/plugins/<id>` 只有「已加载插件自行注册的路由」这一种形态。

因此「安装扩展」能把代码拉到 `data/<用户>/extensions/`，却无法搬进 `plugins/`。

## 工作方式

引导器不含业务逻辑，只在酒馆进程内按需加载 `extensions/<扩展目录>/server-plugin/index.js`：

| 端点 | 行为 |
|---|---|
| `GET /api/plugins/v-adapter/status` | 实现是否存在、是否运行、监听地址 |
| `POST /api/plugins/v-adapter/start` | 载入实现并调用其 `init()` |
| `POST /api/plugins/v-adapter/stop` | 调用其 `exit()`，释放端口 |
| `POST /api/plugins/v-adapter/reload` | 先 stop 再 start，用于载入更新后的代码 |

加载时对模块 URL 附加时间戳以绕过 ESM 模块缓存，`reload` 因此能让更新后的代码即刻生效，
无需重启酒馆进程。

酒馆启动时引导器会自动尝试拉起服务，使服务端行为与常规插件一致；失败仅记录告警，
不阻断酒馆启动。

## 环境变量

| 变量 | 作用 |
|---|---|
| `VADAPTER_EXT_DIR` | 指定扩展目录；未设置时扫描进程工作目录下的 `data/<用户>/extensions` |
| `VADAPTER_AUTOSTART` | 设为 `0` 时关闭随酒馆自动启动，改为完全手动启停 |

运行配置固定在引导器目录下的 `data/`，通过 `VADAPTER_DATA_DIR` 注入给服务端实现
（由 `server-plugin/lib/settings.js` 读取），因此扩展的移动与更新不影响已有配置。

## 平台兼容性

纯 Node ESM，无第三方依赖，Windows、Linux、macOS、Termux 均适用。
