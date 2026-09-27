// Modo demonstração (navegador comum ou ?demo): imita uma sessão do SIP.js sem rede,
// para validar a interface sem PBX.
import { uid } from './store.js';

class Emitter {
  constructor() {
    this.fns = [];
  }
  addListener(fn) {
    this.fns.push(fn);
  }
  removeListener(fn) {
    this.fns = this.fns.filter((f) => f !== fn);
  }
  emit(v) {
    this.fns.slice().forEach((f) => f(v));
  }
}

const later = (ms, fn) => setTimeout(fn, ms);

export class FakeSession {
  constructor(direction, number, name = '') {
    this.direction = direction;
    this.remoteIdentity = { uri: { user: number }, displayName: name };
    this.state = 'Initial';
    this.stateChange = new Emitter();
    this.data = {};
    this.delegate = {};
    this.sessionDescriptionHandler = { sendDtmf: () => true };
    this.sessionDescriptionHandlerOptionsReInvite = {};
    if (direction === 'in') this._timeout = later(30000, () => this._set('Terminated'));
  }
  _set(s) {
    if (this.state === 'Terminated' || this.state === s) return;
    this.state = s;
    clearTimeout(this._timeout);
    this.stateChange.emit(s);
  }
  progress() {
    return Promise.resolve();
  }
  accept() {
    clearTimeout(this._timeout);
    this._set('Establishing');
    later(350, () => this._set('Established'));
    return Promise.resolve();
  }
  reject() {
    later(50, () => this._set('Terminated'));
    return Promise.resolve();
  }
  cancel() {
    return this.reject();
  }
  bye() {
    return this.reject();
  }
  invite(opts = {}) {
    const d = opts.requestDelegate || {};
    if (this.state === 'Established') {
      later(150, () => d.onAccept?.({}));
      return Promise.resolve();
    }
    this._set('Establishing');
    later(600, () => this.state !== 'Terminated' && d.onProgress?.({ message: { body: '' } }));
    later(2600, () => this.state !== 'Terminated' && this._set('Established'));
    return Promise.resolve();
  }
  refer(_target, opts = {}) {
    later(400, () => opts.requestDelegate?.onAccept?.({}));
    later(900, () => opts.onNotify?.({ request: { body: 'SIP/2.0 200 OK' } }));
    return Promise.resolve();
  }
  info() {
    return Promise.resolve();
  }
}

export function seedDemo(store) {
  const base = { password: '', authUser: '', displayName: '', enabled: true, transport: 'UDP', proxy: '', expires: 300, natDetect: true, forward: { mode: 'off', target: '', seconds: 20 }, dnd: false, autoAnswer: false };
  store.accounts = [
    { ...base, id: uid(), name: 'Suporte', color: '#00C9B1', user: '1001', domain: 'pbx.vincii.com.br' },
    { ...base, id: uid(), name: 'Comercial', color: '#4DA3FF', user: '2001', domain: 'pbx.vincii.com.br', forward: { mode: 'noanswer', target: '2002', seconds: 20 } },
    { ...base, id: uid(), name: 'Provedor NetSul', color: '#F5B83D', user: '7310', domain: 'voip.netsul.net', transport: 'TCP' },
  ];
  store.saveAccounts();
}

const CALLERS = [
  ['11987654321', 'Mariana Costa'],
  ['4832221100', 'Loja Centro'],
  ['21999887766', ''],
  ['5130304040', 'Carlos Menezes'],
  ['1140028922', 'Fibra Total'],
  ['8599112233', ''],
];

export const randomCaller = () => CALLERS[Math.floor(Math.random() * CALLERS.length)];
