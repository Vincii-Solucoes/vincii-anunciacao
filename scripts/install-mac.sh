#!/bin/sh
# Compila o app para este Mac e instala em /Applications (substituindo a versão anterior).
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
npm run build
# Gera fora da pasta do projeto: Mesa/Documentos sincronizados com o iCloud recolocam atributos
# estendidos nos arquivos e fazem a assinatura ad-hoc falhar.
OUT=$(mktemp -d "${TMPDIR:-/tmp}/anunciacao-build.XXXXXX")
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --"$ARCH" --publish never -c.directories.output="$OUT"
APP=$(ls -d "$OUT"/mac*/"Vincii Anunciacao.app" | head -1)
DEST="/Applications/Vincii Anunciacao.app"
# Fecha a versão aberta (nome atual ou o antigo "Anunciacao").
pkill -f "/Applications/Vincii Anunciacao.app/Contents/MacOS/" 2>/dev/null || true
pkill -f "/Applications/Anunciacao.app/Contents/MacOS/" 2>/dev/null || true
sleep 1
rm -rf "$DEST" /Applications/Anunciacao.app
ditto "$APP" "$DEST"
xattr -cr "$DEST"
rm -rf "$OUT"
open "$DEST"
echo "Instalado: $DEST ($(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist"))"
