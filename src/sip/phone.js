import { UserAgent, Registerer, RegistererState, Inviter, SessionState } from 'sip.js';
import { uid } from '../store.js';
import { makeTransportClass } from './transport.js';
import { makeSdhFactory } from './sdh.js';
import { MediaEngine } from '../media/engine.js';
import { FakeSession } from '../demo.js';
import { enabledCodecs } from '../media/codecs.js';

const CONN_KEYS = ['user', 'domain', 'password', 'authUser', 'displayName', 'enabled', 'transport', 'proxy', 'expires', 'natDetect', 'tlsVerify'];

const STATUS_TEXT = {
  400: 'Requisição inválida',
  401: 'Falha de autenticação (usuário ou senha)',
  403: 'Acesso negado (usuário ou senha)',
  404: 'Número não encontrado',
  407: 'Falha de autenticação no proxy',
  408: 'Sem resposta',
  410: 'Número não existe mais',
  480: 'Destino indisponível no PBX',
  484: 'Número incompleto',
  486: 'Ocupado',
  487: 'Cancelada',
  488: 'Mídia incompatível',
  500: 'Erro no servidor',
  503: 'Serviço indisponível',
  600: 'Ocupado',
  603: 'Chamada recusada',
  604: 'Número não existe',
};
export const statusText = (code, reason) => STATUS_TEXT[code] || (code ? `${code} ${reason || ''}`.trim() : reason || 'Falha na chamada');

const token = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[(Math.random() * 36) | 0]).join('');
const LIVE = ['active', 'held'];

export class Phone extends EventTarget {
  constructor(store, { bridge = null, demo = false } = {}) {
    super();
    this.store = store;
    this.bridge = bridge;
    this.demo = demo;
    this.lines = new Map();
    this.calls = new Map();
    if (bridge) {
      this.engine = new MediaEngine(bridge.net, store.settings);
      this.Transport = makeTransportClass(bridge.net);
      this.sdhFactory = makeSdhFactory(this.engine);
      this.engine.onLevel = (v) => this.emit('level', v);
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  changed() {
    this.emit('change');
    this._reportStatus();
  }

  _reportStatus() {
    if (!this.bridge) return;
    const lines = [...this.lines.values()];
    const calls = [...this.calls.values()];
    this.bridge.app.status({
      online: lines.filter((l) => l.status === 'registered').length,
      total: lines.length,
      ringing: calls.filter((c) => c.state === 'ringing').length,
      calls: calls.length,
      dnd: !!this.store.settings.dnd,
    });
  }

  /* ================= Linhas ================= */

  syncAccounts() {
    const accounts = this.store.accounts;
    for (const [id, line] of this.lines) {
      if (!accounts.some((a) => a.id === id)) this._stopLine(line);
    }
    const next = new Map();
    for (const acc of accounts) {
      const line = this.lines.get(acc.id);
      if (line && CONN_KEYS.every((k) => line.account[k] === acc[k])) {
        line.account = acc;
        next.set(acc.id, line);
      } else {
        if (line) this._stopLine(line);
        next.set(acc.id, this._startLine(acc));
      }
    }
    this.lines = next;
    this.changed();
  }

  _startLine(account) {
    const line = { account, ua: null, registerer: null, status: 'disabled', error: '', stopped: false, retry: null, retryDelay: 15000, watchdog: null };
    if (!account.enabled) return line;
    if (this.demo || !this.bridge) {
      line.status = 'registered';
      return line;
    }
    const uri = UserAgent.makeURI(`sip:${account.user}@${account.domain}`);
    if (!uri) {
      line.status = 'failed';
      line.error = 'Endereço SIP inválido';
      return line;
    }
    const viaHost = `${token(12)}.invalid`;
    const ua = new UserAgent({
      uri,
      authorizationUsername: account.authUser || account.user,
      authorizationPassword: account.password,
      displayName: account.displayName || undefined,
      // contactName vazio: o SIP.js gera um usuário aleatório e casa o Contact só pelo usuário,
      // o que sobrevive a PBXs que reescrevem host/porta (NAT).
      contactParams: { transport: (account.transport || 'UDP').toLowerCase() },
      viaHost,
      forceRport: true,
      userAgentString: 'VinciiAnunciacao/2.3',
      noAnswerTimeout: 180,
      logLevel: 'warn',
      transportConstructor: this.Transport,
      transportOptions: {
        account,
        viaHost,
        onPublicAddress: () => !line.stopped && line.registerer?.register().catch(() => {}),
      },
      sessionDescriptionHandlerFactory: this.sdhFactory,
      delegate: {
        onInvite: (inv) => this._onInvite(line, inv),
        onDisconnect: (err) => {
          if (line.stopped) return;
          this._setLine(line, 'failed', err?.message || 'Conexão perdida');
          this._scheduleRetry(line);
        },
      },
    });
    line.ua = ua;
    line.registerer = new Registerer(ua, { expires: Number(account.expires) || 300 });
    line.registerer.stateChange.addListener((s) => {
      if (line.stopped) return;
      if (s === RegistererState.Registered) {
        clearTimeout(line.watchdog);
        line.retryDelay = 15000;
        this._setLine(line, 'registered');
      } else if (s === RegistererState.Unregistered && line.status === 'registered') {
        this._setLine(line, 'failed', 'Registro expirou');
        this._scheduleRetry(line);
      }
    });
    this._connectLine(line, true);
    return line;
  }

  _setLine(line, status, error = '') {
    line.status = status;
    line.error = error;
    this.changed();
  }

  async _connectLine(line, first = false) {
    if (line.stopped) return;
    clearTimeout(line.retry);
    this._setLine(line, 'connecting');
    try {
      if (first) await line.ua.start();
      else if (!line.ua.transport.isConnected()) await line.ua.reconnect();
      this._register(line);
    } catch (err) {
      if (line.stopped) return;
      this._setLine(line, 'failed', err?.message?.includes('ENOTFOUND') ? 'Servidor não encontrado (DNS)' : err?.message || 'Falha de conexão');
      this._scheduleRetry(line);
    }
  }

  _register(line) {
    clearTimeout(line.watchdog);
    // Sem resposta do servidor em 35 s: considera falha e tenta de novo.
    line.watchdog = setTimeout(() => {
      if (line.stopped || line.status === 'registered') return;
      this._setLine(line, 'failed', 'O servidor não respondeu');
      this._scheduleRetry(line);
    }, 35000);
    line.registerer
      .register({
        requestDelegate: {
          onReject: (res) => {
            clearTimeout(line.watchdog);
            const m = res.message;
            this._setLine(line, 'failed', statusText(m.statusCode, m.reasonPhrase));
            this._scheduleRetry(line);
          },
        },
      })
      .catch((err) => {
        if (!line.stopped) {
          this._setLine(line, 'failed', err?.message || 'Falha no registro');
          this._scheduleRetry(line);
        }
      });
  }

  _scheduleRetry(line) {
    if (line.stopped) return;
    clearTimeout(line.retry);
    line.retry = setTimeout(() => this._connectLine(line), line.retryDelay);
    line.retryDelay = Math.min(line.retryDelay * 2, 300000);
  }

  reconnect(accountId) {
    const line = this.lines.get(accountId);
    if (line?.ua) {
      line.retryDelay = 15000;
      this._connectLine(line);
    }
  }

  _stopLine(line) {
    line.stopped = true;
    clearTimeout(line.retry);
    clearTimeout(line.watchdog);
    for (const call of this.calls.values()) if (call.accountId === line.account.id) this._terminate(call);
    const ua = line.ua;
    if (ua) {
      (line.status === 'registered' ? line.registerer.unregister().catch(() => {}) : Promise.resolve())
        .then(() => new Promise((r) => setTimeout(r, 300)))
        .finally(() => ua.stop().catch(() => {}));
    }
  }

  stopAll() {
    for (const line of this.lines.values()) this._stopLine(line);
  }

  setDnd(on) {
    this.store.settings.dnd = !!on;
    this.store.saveSettings();
    this.changed();
  }

  /* ================= Chamadas ================= */

  _targetUri(line, target) {
    let t = String(target || '').trim().replace(/^(sips?|tel):/i, '');
    if (!t.includes('@')) t = `${t.replace(/[\s()-]/g, '')}@${line.account.domain}`;
    return UserAgent.makeURI(`sip:${t}`);
  }

  _newCall(line, session, direction) {
    const ri = session.remoteIdentity;
    const call = {
      id: uid(),
      accountId: line.account.id,
      session,
      direction,
      number: ri?.uri?.user || '',
      name: ri?.displayName || '',
      state: direction === 'in' ? 'ringing' : 'dialing',
      muted: false,
      held: false,
      remoteHold: false,
      conf: false,
      early: false,
      codec: '',
      consultFor: null,
      result: null,
      cause: '',
      createdAt: Date.now(),
      answeredAt: null,
    };
    // Número real em P-Asserted-Identity, quando a operadora envia.
    const pai = session.request?.getHeader?.('P-Asserted-Identity');
    const paiUser = pai?.match(/(?:sip|tel):\+?([^@;>]+)/i)?.[1];
    if (paiUser && direction === 'in') call.number = paiUser;

    session.data = {
      callId: call.id,
      codecs: enabledCodecs(line.account.codecs),
      onMedia: (m) => {
        call.remoteHold = m.remoteHold;
        call.codec = m.codec;
        // Mídia negociada (inclusive 183 com SDP): liga o fluxo RTP já na fase de progresso.
        this.engine?.setState(call.id, { active: true, early: !call.answeredAt });
        this.changed();
      },
    };
    session.delegate = {
      onRefer: (referral) => this._onReferred(line, call, referral),
    };
    session.stateChange.addListener((s) => {
      if (s === SessionState.Established) {
        if (!call.answeredAt) call.answeredAt = Date.now();
        clearTimeout(call.fwTimer);
        if (!LIVE.includes(call.state)) call.state = call.held ? 'held' : 'active';
        this.engine?.setState(call.id, { active: true, early: false, held: call.held, muted: call.muted, conf: call.conf });
        this.changed();
      } else if (s === SessionState.Terminated) {
        this._finish(call);
      }
    });
    this.calls.set(call.id, call);
    return call;
  }

  _busy(exceptId) {
    for (const c of this.calls.values()) if (c.id !== exceptId && c.state !== 'ringing') return true;
    return false;
  }

  _onInvite(line, invitation) {
    const call = this._newCall(line, invitation, 'in');
    const acc = line.account;
    const fw = acc.forward || {};

    if (this.store.settings.dnd || acc.dnd) {
      call.result = 'dnd';
      invitation.reject({ statusCode: 486, reasonPhrase: 'Busy Here' }).catch(() => {});
      return;
    }
    if (fw.target && (fw.mode === 'always' || (fw.mode === 'busy' && this._busy(call.id)))) {
      this._redirect(call, fw.target);
      return;
    }
    invitation.progress().catch(() => {});
    if (fw.target && fw.mode === 'noanswer') {
      call.fwTimer = setTimeout(() => call.state === 'ringing' && this._redirect(call, fw.target), (Number(fw.seconds) || 20) * 1000);
    }
    if (acc.autoAnswer && !this._busy(call.id)) setTimeout(() => call.state === 'ringing' && this.answer(call.id), 800);
    this.emit('incoming', call);
    this.changed();
  }

  _redirect(call, target) {
    const line = this.lines.get(call.accountId);
    const uri = this._targetUri(line, target);
    call.result = 'forwarded';
    call.cause = `Desviada para ${target}`;
    call.session
      .reject({ statusCode: 302, reasonPhrase: 'Moved Temporarily', extraHeaders: [`Contact: <${uri}>`] })
      .catch(() => {});
  }

  call(accountId, target, { consultFor = null } = {}) {
    const line = this.lines.get(accountId);
    if (!String(target || '').trim()) throw new Error('Digite um número ou ramal');
    if (!line || line.status !== 'registered') throw new Error('A linha selecionada não está registrada');
    let session;
    if (this.demo || !this.bridge) {
      session = new FakeSession('out', String(target).trim());
    } else {
      const uri = this._targetUri(line, target);
      if (!uri) throw new Error('Número inválido');
      session = new Inviter(line.ua, uri, { earlyMedia: true });
    }
    const call = this._newCall(line, session, 'out');
    call.consultFor = consultFor;
    this._holdOthers(call.id);
    session
      .invite({
        requestDelegate: {
          onProgress: (res) => {
            if (call.state === 'dialing') call.state = 'ringback';
            if (res.message.body) call.early = true;
            this.changed();
          },
          onReject: (res) => {
            call.cause = statusText(res.message.statusCode, res.message.reasonPhrase);
          },
        },
      })
      .catch((err) => {
        call.cause = err?.message || 'Falha ao iniciar a chamada';
        if (session.state === SessionState.Initial) this._finish(call);
      });
    this.changed();
    return call;
  }

  _get(id) {
    const call = this.calls.get(id);
    if (!call) throw new Error('Chamada não encontrada');
    return call;
  }

  _terminate(call) {
    const s = call.session;
    try {
      if (s.state === SessionState.Established) return s.bye().catch(() => {});
      if (s.state === SessionState.Initial || s.state === SessionState.Establishing) {
        if (call.direction === 'out') {
          call.result = 'cancelled';
          return s.cancel().catch(() => {});
        }
        call.result = call.result || 'rejected';
        return s.reject({ statusCode: 486 }).catch(() => {});
      }
    } catch {
      /* já encerrada */
    }
  }

  // Coloca em espera tudo que não for a chamada em foco (ou a conferência dela).
  _holdOthers(focusId) {
    if (!this.store.settings.autoHold) return;
    const focus = this.calls.get(focusId);
    for (const c of this.calls.values()) {
      if (c.id === focusId || c.state !== 'active' || c.held) continue;
      if (focus?.conf && c.conf) continue;
      this._setHold(c, true);
    }
  }

  _setHold(call, hold) {
    const s = call.session;
    if (s.state !== SessionState.Established || call.holdPending) return Promise.resolve(false);
    call.holdPending = true;
    if (hold) this.engine?.setState(call.id, { held: true });
    return new Promise((resolve) => {
      const done = (ok) => {
        call.holdPending = false;
        if (ok) {
          call.held = hold;
          call.state = hold ? 'held' : 'active';
        } else {
          s.sessionDescriptionHandlerOptionsReInvite = { hold: call.held };
          this.emit('error', hold ? 'Não foi possível colocar em espera' : 'Não foi possível retomar a chamada');
        }
        this.engine?.setState(call.id, { held: call.held });
        this.changed();
        resolve(ok);
      };
      try {
        s.invite({
          sessionDescriptionHandlerOptions: { hold },
          requestDelegate: { onAccept: () => done(true), onReject: () => done(false) },
        }).catch(() => done(false));
      } catch {
        done(false);
      }
    });
  }

  answer(id) {
    const call = this._get(id);
    if (call.state !== 'ringing') return;
    clearTimeout(call.fwTimer);
    this._holdOthers(id);
    call.state = 'connecting';
    call.session.accept().catch((err) => {
      call.cause = err?.message || 'Falha ao atender';
      this.emit('error', call.cause);
    });
    this.changed();
  }

  reject(id) {
    const call = this._get(id);
    clearTimeout(call.fwTimer);
    call.result = 'rejected';
    call.session.reject({ statusCode: 486, reasonPhrase: 'Busy Here' }).catch(() => {});
  }

  hangup(id) {
    this._terminate(this._get(id));
  }

  toggleMute(id) {
    const call = this._get(id);
    call.muted = !call.muted;
    this.engine?.setState(id, { muted: call.muted });
    this.changed();
  }

  toggleHold(id) {
    const call = this._get(id);
    const hold = !call.held;
    const group = call.conf ? [...this.calls.values()].filter((c) => c.conf) : [call];
    if (!hold) this._holdOthers(id);
    group.forEach((c) => c.held !== hold && this._setHold(c, hold));
  }

  dtmf(id, digit) {
    const call = this._get(id);
    const s = call.session;
    if (s.state !== SessionState.Established) return;
    if (this.store.settings.dtmfMode === 'info') {
      s.info({
        requestOptions: {
          body: { contentDisposition: 'render', contentType: 'application/dtmf-relay', content: `Signal=${digit}\r\nDuration=160` },
        },
      }).catch(() => {});
    } else {
      s.sessionDescriptionHandler?.sendDtmf(digit);
    }
  }

  /* ---------- Transferências ---------- */

  _referOptions(call, label) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      call.result = 'transferred';
      call.cause = label;
      this._terminate(call);
    };
    return {
      requestDelegate: {
        onAccept: () => {
          this.emit('notice', `Transferência aceita: ${label}`);
          setTimeout(finish, 4000);
        },
        onReject: (res) => this.emit('error', `Transferência recusada (${statusText(res.message.statusCode, res.message.reasonPhrase)})`),
      },
      onNotify: (n) => {
        n.accept?.().catch?.(() => {});
        const frag = String(n.request?.body || '');
        const code = Number(frag.match(/SIP\/2\.0\s+(\d{3})/)?.[1]);
        if (code >= 200 && code < 300) finish();
        else if (code >= 300) {
          finished = true;
          this.emit('error', `O destino não atendeu a transferência (${statusText(code)})`);
        }
      },
    };
  }

  // Transferência direta (cega).
  transfer(id, target) {
    const call = this._get(id);
    const dest = String(target || '').trim();
    if (!dest) throw new Error('Informe o destino da transferência');
    if (call.session.state !== SessionState.Established) throw new Error('A chamada ainda não foi atendida');
    const line = this.lines.get(call.accountId);
    const uri = this.demo || !this.bridge ? dest : this._targetUri(line, dest);
    call.session.refer(uri, this._referOptions(call, `para ${dest}`));
  }

  // Transferência assistida: conecta a chamada `id` com a chamada `targetId` (REFER com Replaces).
  attendedTransfer(id, targetId) {
    const a = this._get(id);
    const b = this._get(targetId);
    if (a.session.state !== SessionState.Established || b.session.state !== SessionState.Established) {
      throw new Error('As duas chamadas precisam estar atendidas');
    }
    const label = `para ${b.name || b.number}`;
    const opts = this._referOptions(a, label);
    const onAccept = opts.requestDelegate.onAccept;
    opts.requestDelegate.onAccept = () => {
      b.result = 'transferred';
      b.cause = `para ${a.name || a.number}`;
      onAccept();
      // O destino encerra a consulta via Replaces; garantimos caso não o faça.
      setTimeout(() => this.calls.has(b.id) && (b.result = 'transferred') && this._terminate(b), 6000);
    };
    a.session.refer(b.session, opts);
  }

  // Inicia a consulta (liga para o destino deixando a chamada original em espera).
  consult(id, target) {
    const a = this._get(id);
    return this.call(a.accountId, target, { consultFor: id });
  }

  // Recebemos um REFER (o outro lado nos transferiu): liga para o novo destino.
  _onReferred(line, call, referral) {
    referral
      .accept()
      .then(() => {
        const inviter = referral.makeInviter({ earlyMedia: true });
        const nc = this._newCall(line, inviter, 'out');
        this._holdOthers(nc.id);
        inviter.invite().catch(() => {});
        call.result = 'transferred';
        this._terminate(call);
        this.emit('notice', `Transferido para ${nc.number}`);
        this.changed();
      })
      .catch(() => {});
  }

  /* ---------- Conferência (mixagem local, como o Linphone) ---------- */

  mergeConference() {
    const members = [...this.calls.values()].filter((c) => LIVE.includes(c.state));
    if (members.length < 2) throw new Error('São necessárias pelo menos duas chamadas atendidas');
    for (const c of members) {
      c.conf = true;
      this.engine?.setState(c.id, { conf: true });
      if (c.held) this._setHold(c, false);
    }
    this.changed();
  }

  leaveConference(id) {
    const call = this._get(id);
    call.conf = false;
    this.engine?.setState(id, { conf: false });
    const rest = [...this.calls.values()].filter((c) => c.conf);
    if (rest.length < 2) rest.forEach((c) => {
      c.conf = false;
      this.engine?.setState(c.id, { conf: false });
    });
    if (this.store.settings.autoHold) this._setHold(call, true);
    this.changed();
  }

  endConference() {
    for (const c of [...this.calls.values()]) if (c.conf) this._terminate(c);
  }

  /* ---------- Encerramento ---------- */

  _finish(call) {
    if (!this.calls.has(call.id)) return;
    this.calls.delete(call.id);
    clearTimeout(call.fwTimer);
    this.engine?.close(call.id);
    if (call.conf) {
      const rest = [...this.calls.values()].filter((c) => c.conf);
      if (rest.length < 2) rest.forEach((c) => {
        c.conf = false;
        this.engine?.setState(c.id, { conf: false });
      });
    }

    // Motivo da recusa guardado pelo transporte (quando o delegate não recebeu a resposta final).
    if (!call.cause && !call.answeredAt && call.direction === 'out') {
      const f = this.lines.get(call.accountId)?.ua?.transport?.finals?.get(call.session.request?.callId);
      if (f) call.cause = `${statusText(f.code, f.reason)} (${f.code}${f.q850 ? `, Q.850 ${f.q850}` : ''})`;
    }

    let result = call.result;
    if (!result || (result === 'cancelled' && call.answeredAt)) {
      if (call.answeredAt) result = 'answered';
      else if (call.direction === 'in') result = 'missed';
      else result = 'failed';
    }
    if (call.answeredAt && ['rejected', 'cancelled'].includes(result)) result = 'answered';

    const line = this.lines.get(call.accountId);
    this.store.addHistory({
      id: call.id,
      accountId: call.accountId,
      lineName: line?.account.name || line?.account.user || '',
      number: call.number,
      name: call.name,
      direction: call.direction,
      result,
      cause: result === 'failed' || result === 'forwarded' || result === 'transferred' ? call.cause : result === 'dnd' ? 'Não perturbe' : '',
      at: call.createdAt,
      duration: call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0,
    });
    this.emit('ended', { call, result });
    this.changed();
  }

  /* ---------- Demonstração ---------- */

  simulateIncoming(accountId, number, name) {
    const line = this.lines.get(accountId);
    if (!line) return;
    this._onInvite(line, new FakeSession('in', number, name));
  }
}
