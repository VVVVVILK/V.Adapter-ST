#!/bin/sh
# ============================================================
#  V.Adapter - 一键部署服务端引导器（Linux / macOS / Termux）
#
#  自动完成三件事，无需手工编辑任何文件：
#    1. 找到酒馆根目录
#    2. 安装引导器到 <酒馆>/plugins/V.Adapter/
#    3. 把 config.yaml 的 enableServerPlugins 改为 true（自动备份）
#
#  运行完成后重启酒馆一次即可。
#
#  用法：sh install-loader.sh
#        sh install-loader.sh /root/SillyTavern
# ============================================================

DIR=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  if [ -x "$DIR/../../../../node/bin/node" ]; then
    NODE="$DIR/../../../../node/bin/node"
  elif [ -x "$DIR/../../../../node/node" ]; then
    NODE="$DIR/../../../../node/node"
  else
    echo "[错误] 未找到 node。请先安装 Node.js（Termux: pkg install nodejs）。"
    exit 1
  fi
else
  NODE=node
fi

"$NODE" "$DIR/install-loader.mjs" "$@"
CODE=$?

echo
if [ "$CODE" = "0" ]; then
  echo "[完成] 请重启酒馆一次，之后无需再做任何配置。"
else
  echo "[失败] 见上方提示。可手动指定酒馆目录："
  echo "       sh install-loader.sh /root/SillyTavern"
fi
exit $CODE
