#!/bin/sh
# Compila o app para este Mac e instala em /Applications (substituindo a versão anterior).
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
npm run build
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --"$ARCH" --publish never
APP=$(ls -d release/mac*/Anunciacao.app | head -1)
osascript -e 'quit app "Anunciacao"' 2>/dev/null || true
sleep 1
pkill -f "/Applications/Anunciacao.app/Contents/MacOS/Anunciacao" 2>/dev/null || true
rm -rf /Applications/Anunciacao.app
ditto "$APP" /Applications/Anunciacao.app
xattr -cr /Applications/Anunciacao.app
rm -rf release
open /Applications/Anunciacao.app
echo "Instalado: /Applications/Anunciacao.app ($(plutil -extract CFBundleShortVersionString raw /Applications/Anunciacao.app/Contents/Info.plist))"
