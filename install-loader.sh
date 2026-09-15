#!/bin/sh
# V.Adapter - install the server loader into SillyTavern
#
# Run this once after installing the extension itself.
# It copies bootstrap/ into <ST>/plugins/V.Adapter/ so that the drawer
# button can start the NovelAI protocol service.
#
# Existing runtime config in <ST>/plugins/V.Adapter/data/ is kept.
#
# Usage:  sh install-loader.sh
#         ST=/path/to/SillyTavern sh install-loader.sh
# Works on Linux, macOS and Termux.

set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
BOOT="$SRC/bootstrap"

# EDIT THIS, or pass ST=... in the environment.
ST="${ST:-$HOME/SillyTavern}"

DST="$ST/plugins/V.Adapter"

if [ ! -f "$BOOT/index.js" ]; then
    echo "[error] bootstrap/index.js not found in $BOOT"
    echo "        Run this script from inside the V.Adapter folder."
    exit 1
fi

if [ ! -d "$ST" ]; then
    echo "[error] SillyTavern not found: $ST"
    echo "        Edit ST in this file, or run: ST=/path/to/SillyTavern sh install-loader.sh"
    exit 1
fi

mkdir -p "$DST/data"

cp -f "$BOOT/index.js"     "$DST/index.js"
cp -f "$BOOT/package.json" "$DST/package.json"

echo
echo "[ok] loader installed -> $DST"
echo "     runtime config kept in $DST/data"
echo
echo "Next: set enableServerPlugins: true in config.yaml, restart SillyTavern,"
echo "      then open the V.Adapter drawer and press 'Start protocol service'."
