// Atualização automática pelo GitHub Releases (mesmo modelo do Palette/Vincii Canvas).
// Windows e Linux (AppImage e .deb) baixam sozinhos e perguntam se reiniciam; no macOS, sem assinatura
// da Apple, o Squirrel não consegue trocar o app — então só avisamos e abrimos a página de download.
// Dormente em desenvolvimento e em builds sem app-update.yml. Verifica 8 s depois de abrir, a cada
// hora e quando a janela volta ao foco (no máximo a cada 30 min). Registro em <dados>/logs/updater.log.
import { app, dialog, shell, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASES_URL = 'https://github.com/Vincii-Solucoes/vincii-anunciacao/releases/latest';
const CHECK_INTERVAL = 60 * 60 * 1000;
const FOCUS_THROTTLE = 30 * 60 * 1000;
const isMac = process.platform === 'darwin';

const state = { status: 'unsupported', version: null, percent: 0, message: '', checkedAt: null, since: 0, current: app.getVersion() };
let autoUpdater = null;
let ctx = null; // { getWin, send, setQuitting }
let lastCheck = 0;
let manual = false;
let watchdog = null;
let offered = null; // macOS: versão já oferecida nesta sessão
const live = new Set(); // mantém as notificações vivas para o clique funcionar

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'updater.log'), `${line}\n`);
  } catch {
    /* ignora */
  }
}

function setState(patch) {
  if (patch.status && patch.status !== state.status) state.since = Date.now();
  Object.assign(state, patch);
  // Verificação ou download travados viram erro (e liberam o botão) em vez de ficar "Verificando…" para sempre.
  clearTimeout(watchdog);
  if (state.status === 'checking') watchdog = setTimeout(() => setState({ status: 'error', message: 'a verificação não respondeu em 90 s' }), 90000);
  if (state.status === 'downloading') watchdog = setTimeout(() => setState({ status: 'error', message: 'o download parou' }), 5 * 60 * 1000);
  ctx?.send('update:state', { ...state });
}

const windowVisible = () => {
  const w = ctx?.getWin();
  return !!w && !w.isDestroyed() && w.isVisible();
};

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    live.delete(n);
    onClick();
  });
  live.add(n);
  setTimeout(() => live.delete(n), 60 * 60 * 1000);
  n.show();
}

export function getUpdateState() {
  return { ...state };
}

export async function setupUpdater(options) {
  ctx = options;
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    ({ autoUpdater } = (await import('electron-updater')).default);
  } catch (e) {
    log('electron-updater indisponível:', e.message);
    return;
  }
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = !isMac;
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
  state.status = 'idle';
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', message: '' }));
  autoUpdater.on('update-not-available', (info) => setState({ status: 'up-to-date', version: info?.version, checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => {
    setState({ status: isMac ? 'available' : 'downloading', version: info?.version, percent: 0, checkedAt: Date.now() });
    if (isMac) offerDownload();
  });
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p?.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info?.version || state.version, percent: 100 });
    promptRestart();
  });
  autoUpdater.on('error', (err) => setState({ status: 'error', message: err?.message || String(err), checkedAt: Date.now() }));
  setTimeout(() => checkForUpdates(), 8000);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL);
}

// `isManual` (botão "Verificar agora"): avisa de novo mesmo se a versão já foi oferecida.
export function checkForUpdates(isManual = false) {
  if (!autoUpdater) return Promise.resolve({ ...state });
  if (state.status === 'downloaded') {
    if (isManual) promptRestart();
    return Promise.resolve({ ...state });
  }
  const stale = Date.now() - (state.since || 0) > 60000;
  if ((state.status === 'checking' || state.status === 'downloading') && !(isManual && stale)) return Promise.resolve({ ...state });
  lastCheck = Date.now();
  manual = isManual;
  return autoUpdater
    .checkForUpdates()
    .then(() => ({ ...state }))
    .catch((e) => {
      setState({ status: 'error', message: e?.message || String(e), checkedAt: Date.now() });
      return { ...state };
    });
}

export function checkOnFocus() {
  if (autoUpdater && Date.now() - lastCheck > FOCUS_THROTTLE) checkForUpdates();
}

export function openReleases() {
  shell.openExternal(RELEASES_URL);
}

// macOS: só avisa e leva à página de download.
async function offerDownload() {
  const version = state.version || '';
  if (offered === version && !manual) return;
  if (!windowVisible()) {
    offered = version;
    notify('Nova versão do Vincii Anunciação', `Versão ${version} disponível. Clique para baixar.`, openReleases);
    return;
  }
  offered = version;
  const { response } = await dialog.showMessageBox(ctx.getWin(), {
    type: 'info',
    buttons: ['Baixar', 'Depois'],
    defaultId: 0,
    cancelId: 1,
    title: 'Nova versão do Vincii Anunciação',
    message: `Vincii Anunciação ${version} está disponível.`,
    detail: 'Vamos abrir a página de download. Instale por cima da versão atual; suas linhas e configurações continuam.',
  });
  if (response === 0) openReleases();
}

// Windows/Linux: atualização baixada — pergunta se reinicia agora (com a janela escondida, notificação).
async function promptRestart() {
  const version = state.version || '';
  if (!windowVisible()) {
    notify('Atualização do Vincii Anunciação pronta', `Versão ${version} baixada. Clique para reiniciar e atualizar; ela também entra quando você fechar o app.`, installUpdate);
    return;
  }
  const { response } = await dialog.showMessageBox(ctx.getWin(), {
    type: 'info',
    buttons: ['Reiniciar e atualizar', 'Depois'],
    defaultId: 0,
    cancelId: 1,
    title: 'Atualização pronta',
    message: `Vincii Anunciação ${version} foi baixado.`,
    detail: 'Reiniciar agora para aplicar? Se houver ligação em andamento, ela será encerrada. A atualização também entra quando você fechar o app.',
  });
  if (response === 0) installUpdate();
}

export function installUpdate() {
  if (!autoUpdater || state.status !== 'downloaded') return;
  ctx.setQuitting(true);
  // Se o app continuar aberto, a instalação não aconteceu (senha cancelada, pkexec ausente, AppImage sem permissão…).
  const guard = setTimeout(() => {
    ctx.setQuitting(false);
    log('instalação não concluiu em 15 s');
    setState({ status: 'error', message: 'a instalação não foi concluída (senha cancelada ou sistema sem suporte); baixe o instalador' });
  }, 15000);
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    clearTimeout(guard);
    ctx.setQuitting(false);
    log('quitAndInstall falhou:', e.message);
    setState({ status: 'error', message: e.message });
  }
}
