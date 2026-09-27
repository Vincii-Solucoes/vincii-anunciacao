'use strict';

// macOS: remove atributos estendidos (xattr) do app empacotado. Os fusíveis de segurança do
// Electron são aplicados depois deste passo e reassinam o app ad-hoc (resetAdHocDarwinSignature);
// sem esta limpeza o codesign falha com "resource fork ... detritus not allowed".

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('xattr', ['-cr', appPath]);
  console.log('[afterPack] atributos estendidos removidos:', appPath);
};
