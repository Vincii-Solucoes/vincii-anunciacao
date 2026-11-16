'use strict';

// macOS: remove atributos estendidos (xattr) do app empacotado. Os fusíveis de segurança do
// Electron são aplicados depois deste passo e reassinam o app ad-hoc (resetAdHocDarwinSignature);
// sem esta limpeza o codesign falha com "resource fork ... detritus not allowed".

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuração da atualização automática (o electron-builder só a gera para os instaladores;
// o build "dir" do npm run install:mac ficaria sem ela e o app não verificaria atualizações).
function ensureUpdateConfig(context, resourcesDir) {
  const file = path.join(resourcesDir, 'app-update.yml');
  if (fs.existsSync(file)) return;
  const pub = [].concat(context.packager.config.publish || [])[0];
  if (!pub || pub.provider !== 'github') return;
  fs.writeFileSync(file, `owner: ${pub.owner}\nrepo: ${pub.repo}\nprovider: github\nreleaseType: ${pub.releaseType || 'release'}\nupdaterCacheDirName: anunciacao-updater\n`);
  console.log('[afterPack] app-update.yml criado');
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    ensureUpdateConfig(context, path.join(context.appOutDir, 'resources'));
    return;
  }
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  ensureUpdateConfig(context, path.join(appPath, 'Contents', 'Resources'));
  execFileSync('xattr', ['-cr', appPath]);
  console.log('[afterPack] atributos estendidos removidos:', appPath);
};
