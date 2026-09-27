// Preferências de sistema: iniciar com o sistema, iniciar minimizado, bandeja.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  startAtLogin: false,
  startHidden: true,
  closeToTray: true,
  showOnIncoming: true,
  trayHintShown: false,
};

const file = () => path.join(app.getPath('userData'), 'system.json');

export function loadSystem() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSystem(s) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

// Comando que o sistema deve executar no login.
function launchCommand() {
  if (app.isPackaged) return { exe: process.env.APPIMAGE || process.execPath, args: ['--hidden'] };
  return { exe: process.execPath, args: [app.getAppPath(), '--hidden'] };
}

const linuxAutostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'anunciacao.desktop');

export function applyLoginItem(enabled) {
  const { exe, args } = launchCommand();
  if (process.platform === 'linux') {
    const f = linuxAutostartFile();
    if (!enabled) {
      fs.rmSync(f, { force: true });
      return;
    }
    const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Vincii Anunciação',
        'Comment=Cliente VoIP da Vincii',
        `Exec=${[exe, ...args].map(q).join(' ')}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n')
    );
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: exe, args });
}

export function isLoginItemEnabled() {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
  const { exe, args } = launchCommand();
  return app.getLoginItemSettings({ path: exe, args }).openAtLogin;
}

export function launchedHidden() {
  if (process.argv.includes('--hidden')) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}
