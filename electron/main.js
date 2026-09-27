import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, protocol, net as enet, shell, dialog, safeStorage, systemPreferences, session, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sipnet from './net.js';
import { loadSystem, saveSystem, applyLoginItem, isLoginItemEnabled, launchedHidden } from './system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const ASSETS = app.isPackaged ? DIST : path.join(ROOT, 'public');
const ICON = path.join(ASSETS, 'icon.png');
const LOGO = ICON;

// Cores da barra de título (Windows) para cada tema, iguais às do topo do app.
const THEME = {
  dark: { bg: '#050505', bar: '#070909', symbol: '#dfe4e4' },
  light: { bg: '#eef3f3', bar: '#fbfdfd', symbol: '#0a1515' },
};
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

let win = null;
let tray = null;
let quitting = false;
let sys = null;
let status = { online: 0, total: 0, ringing: 0, calls: 0, dnd: false };
let flashTimer = null;
let pendingDial = null;

// Dados sempre na pasta "Anunciacao" (mantém linhas e histórico mesmo com a troca do nome do app).
// VINCII_USER_DATA permite perfis separados (ex.: testes com duas instâncias).
app.setPath('userData', process.env.VINCII_USER_DATA || path.join(app.getPath('appData'), 'Anunciacao'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Serve a interface compilada por um protocolo próprio (contexto seguro para microfone e AudioWorklet).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setAppUserModelId('br.com.vincii.anunciacao');
// Cabeçalhos HTTP só aceitam ASCII: o nome "Anunciação" não pode ir no User-Agent.
app.userAgentFallback = app.userAgentFallback.replace(/[^\x20-\x7e]/g, '');

/* ---------- Links sip: / tel: ---------- */

function extractDial(argv) {
  const uri = argv.find((a) => /^(sip|sips|tel|callto):/i.test(a));
  if (!uri) return null;
  return decodeURIComponent(uri.replace(/^(sips?|tel|callto):(\/\/)?/i, '').split(/[;?]/)[0]);
}

function deliverDial(number) {
  if (!number) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('app:dial', number);
  else pendingDial = number;
  showWindow();
}

if (app.isPackaged) {
  for (const p of ['sip', 'tel', 'callto']) app.setAsDefaultProtocolClient(p);
} else if (process.defaultApp) {
  for (const p of ['sip', 'tel', 'callto']) app.setAsDefaultProtocolClient(p, process.execPath, [path.resolve(process.argv[1] || '.')]);
}

app.on('second-instance', (_e, argv) => {
  const n = extractDial(argv);
  if (n) deliverDial(n);
  else showWindow();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  deliverDial(extractDial([url]));
});

/* ---------- Janela ---------- */

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: THEME[resolvedTheme()].bg,
    title: 'Vincii Anunciação',
    icon: ICON,
    autoHideMenuBar: true,
    // Barra de título integrada ao layout: semáforos no macOS, botões sobrepostos no Windows.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 21 } }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: THEME[resolvedTheme()].bar, symbolColor: THEME[resolvedTheme()].symbol, height: 64 } }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // áudio e SIP continuam ativos na bandeja
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  win.on('close', (e) => {
    if (quitting || !sys.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!sys.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Vincii Anunciação', body: 'O Vincii Anunciação continua rodando na bandeja e recebendo chamadas.', icon: LOGO }).show();
      sys.trayHintShown = true;
      saveSystem(sys);
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    if (pendingDial) {
      win.webContents.send('app:dial', pendingDial);
      pendingDial = null;
    }
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://vincii/index.html');
}

function applyWindowTheme() {
  if (!win || win.isDestroyed()) return;
  const t = THEME[resolvedTheme()];
  win.setBackgroundColor(t.bg);
  if (process.platform === 'win32') win.setTitleBarOverlay?.({ color: t.bar, symbolColor: t.symbol, height: 64 });
}
nativeTheme.on('updated', applyWindowTheme);

/* ---------- Bandeja ---------- */

function trayImage() {
  // macOS: imagem "template" (preta) que o sistema adapta ao menu claro/escuro.
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'tray', 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'tray', process.platform === 'linux' ? 'tray-linux.png' : 'tray.png'));
}

let iconNormal;
const iconBlank = nativeImage.createEmpty();

function updateTray() {
  if (!tray) return;
  const parts = [`Vincii Anunciação — ${status.online}/${status.total} linhas online`];
  if (status.calls) parts.push(`${status.calls} chamada(s)`);
  if (status.ringing) parts.push('Chamada recebida!');
  if (status.dnd) parts.push('Não perturbe');
  tray.setToolTip(parts.join(' · '));

  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Vincii Anunciação', click: showWindow },
    { label: `${status.online}/${status.total} linhas online`, enabled: false },
    { type: 'separator' },
    {
      label: 'Não perturbe',
      type: 'checkbox',
      checked: !!status.dnd,
      click: (i) => win?.webContents.send('app:dnd', i.checked),
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o sistema',
      type: 'checkbox',
      checked: sys.startAtLogin,
      click: (i) => setSystem({ startAtLogin: i.checked }),
    },
    {
      label: 'Iniciar minimizado na bandeja',
      type: 'checkbox',
      checked: sys.startHidden,
      click: (i) => setSystem({ startHidden: i.checked }),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // Pisca o ícone enquanto houver chamada tocando.
  if (status.ringing && !flashTimer) {
    let on = false;
    flashTimer = setInterval(() => tray?.setImage((on = !on) ? iconBlank : iconNormal), 500);
  } else if (!status.ringing && flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
    tray.setImage(iconNormal);
  }
}

function createTray() {
  iconNormal = trayImage();
  tray = new Tray(iconNormal);
  tray.on('click', () => (win?.isVisible() && win.isFocused() && process.platform !== 'darwin' ? win.hide() : showWindow()));
  updateTray();
}

function setSystem(patch) {
  sys = { ...sys, ...patch };
  if ('startAtLogin' in patch || ('startHidden' in patch && sys.startAtLogin)) {
    try {
      applyLoginItem(sys.startAtLogin);
    } catch (err) {
      dialog.showErrorBox('Vincii Anunciação', `Não foi possível alterar a inicialização automática: ${err.message}`);
    }
  }
  saveSystem(sys);
  updateTray();
  win?.webContents.send('app:system', sys);
  return sys;
}

/* ---------- IPC ---------- */

function ipc() {
  sipnet.setNetSink((channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  });

  ipcMain.handle('net:udpOpen', (_e, opts) => sipnet.udpOpen(opts));
  ipcMain.on('net:udpSend', (_e, id, data, port, host) => sipnet.udpSend(id, data, port, host));
  ipcMain.handle('net:streamConnect', (_e, opts) => sipnet.streamConnect(opts));
  ipcMain.on('net:streamSend', (_e, id, text) => sipnet.streamSend(id, text));
  ipcMain.on('net:close', (_e, id) => sipnet.closeSocket(id));
  ipcMain.handle('net:resolve', (_e, opts) => sipnet.resolveServer(opts));
  ipcMain.handle('net:localAddress', (_e, opts) => sipnet.localAddressFor(opts));

  ipcMain.handle('secret:encrypt', (_e, text) => {
    if (!text) return '';
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  });
  ipcMain.handle('secret:decrypt', (_e, data) => {
    if (!data) return '';
    try {
      if (data.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(data.slice(4), 'base64'));
      if (data.startsWith('b64:')) return Buffer.from(data.slice(4), 'base64').toString('utf8');
    } catch {
      /* chave do sistema mudou */
    }
    return '';
  });


  ipcMain.handle('app:getSystem', () => ({ ...sys, startAtLogin: isLoginItemEnabled() || sys.startAtLogin }));
  ipcMain.handle('app:setSystem', (_e, patch) => setSystem(patch));
  ipcMain.on('app:status', (_e, s) => {
    const wasRinging = status.ringing;
    status = { ...status, ...s };
    if (status.ringing > wasRinging) {
      if (sys.showOnIncoming && win) {
        if (!win.isVisible()) win.showInactive();
        win.flashFrame(true);
      }
      if (process.platform === 'darwin') app.dock?.bounce('critical');
    }
    if (process.platform === 'darwin') app.dock?.setBadge(status.ringing ? '●' : '');
    updateTray();
  });
  ipcMain.on('app:show', showWindow);
  ipcMain.on('app:theme', (_e, source) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(source) ? source : 'system';
    applyWindowTheme();
  });
  ipcMain.on('app:quit', () => {
    quitting = true;
    app.quit();
  });
}

/* ---------- Ciclo de vida ---------- */

app.whenReady().then(async () => {
  sys = loadSystem();

  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return enet.fetch(pathToFileURL(file).toString());
  });

  const allowed = new Set(['media', 'notifications', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));

  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }

  // Ícone no Dock durante o desenvolvimento (no app empacotado vem do .icns).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON);

  ipc();
  createTray();
  createWindow(launchedHidden() && sys.startHidden);
  const n = extractDial(process.argv);
  if (n) deliverDial(n);
});

app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // Continua na bandeja; só sai por "Sair".
});
app.on('will-quit', () => sipnet.closeAll());
