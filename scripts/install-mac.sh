#!/bin/sh
# Compila o app para este Mac e instala em /Applications (substituindo a versão anterior).
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
npm run build
rm -rf release
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --"$ARCH" --publish never
APP=$(ls -d release/mac*/"Vincii Anunciacao.app" | head -1)
DEST="/Applications/Vincii Anunciacao.app"
# Fecha a versão aberta (nome atual ou o antigo "Anunciacao").
pkill -f "/Applications/Vincii Anunciacao.app/Contents/MacOS/" 2>/dev/null || true
pkill -f "/Applications/Anunciacao.app/Contents/MacOS/" 2>/dev/null || true
sleep 1
rm -rf "$DEST" /Applications/Anunciacao.app
ditto "$APP" "$DEST"
xattr -cr "$DEST"
rm -rf release
open "$DEST"
echo "Instalado: $DEST ($(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist"))"
