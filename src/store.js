// Persistência local (localStorage). O modo demonstração usa um namespace separado
// para nunca misturar contas fictícias com as reais.
export const NATIVE = typeof window !== 'undefined' && !!window.vincii;
export const DEMO = !NATIVE || new URLSearchParams(location.search).has('demo');
const NS = DEMO ? 'anunciacao-demo' : 'anunciacao';

const DEFAULT_SETTINGS = {
  micId: '',
  speakerId: '',
  autoHold: true,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  codecs: [8, 0], // PCMA, PCMU
  dtmfMode: 'rfc2833',
  rtpMin: 10000,
  rtpMax: 20000,
  dnd: false,
  theme: 'system', // system | light | dark
};

export const ACCOUNT_DEFAULTS = {
  name: '',
  color: '#00C9B1',
  user: '',
  domain: '',
  password: '',
  authUser: '',
  displayName: '',
  enabled: true,
  transport: 'UDP',
  proxy: '',
  expires: 300,
  natDetect: true,
  tlsVerify: true,
  dnd: false,
  autoAnswer: false,
  forward: { mode: 'off', target: '', seconds: 20 },
};

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`${NS}:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`${NS}:${key}`, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível: segue só em memória */
  }
}

export const store = {
  accounts: load('accounts', []).map((a) => ({ ...ACCOUNT_DEFAULTS, ...a, forward: { ...ACCOUNT_DEFAULTS.forward, ...(a.forward || {}) } })),
  settings: { ...DEFAULT_SETTINGS, ...load('settings', {}) },
  history: load('history', []),

  // No app desktop, a senha é gravada criptografada pelo cofre do sistema (safeStorage).
  async saveAccounts() {
    const list = await Promise.all(
      this.accounts.map(async ({ password, ...a }) =>
        NATIVE ? { ...a, passwordEnc: await window.vincii.secret.encrypt(password || '') } : { ...a, password }
      )
    );
    save('accounts', list);
  },
  async unlock() {
    if (!NATIVE) return;
    for (const a of this.accounts) {
      if (a.passwordEnc != null) a.password = await window.vincii.secret.decrypt(a.passwordEnc);
      delete a.passwordEnc;
    }
  },
  saveSettings() {
    save('settings', this.settings);
  },
  addHistory(entry) {
    this.history.unshift(entry);
    if (this.history.length > 200) this.history.length = 200;
    save('history', this.history);
  },
  updateHistory(id, patch) {
    const h = this.history.find((x) => x.id === id);
    if (h) {
      Object.assign(h, patch);
      save('history', this.history);
    }
  },
  clearHistory() {
    this.history = [];
    save('history', this.history);
  },
};

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
