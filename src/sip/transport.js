// Transporte SIP.js sobre UDP/TCP/TLS, usando os sockets do processo principal.
// Também cuida do que o SIP.js não faz para UDP: retransmissão de requisições,
// keep-alive de NAT e reescrita de Via/Contact com o endereço real.
import { TransportState, EmitterImpl } from 'sip.js';
import { log } from '../log.js';

const T1 = 500;
const T2 = 4000;

const topVia = (msg) => msg.match(/^(?:via|v)\s*:\s*([^\r\n]+)/im)?.[1] || '';
const branchOf = (via) => via.match(/;\s*branch=([^;,\s]+)/i)?.[1] || '';
const cseqOf = (msg) => msg.match(/^cseq\s*:\s*(\d+)\s+(\w+)/im);

export function makeTransportClass(net) {
  return class NativeTransport {
    constructor(logger, options) {
      this.logger = logger;
      this.opts = options; // { account, viaHost, onPublicAddress }
      this.protocol = options.account.transport || 'UDP';
      this._state = TransportState.Disconnected;
      this.stateChange = new EmitterImpl();
      this.onConnect = undefined;
      this.onDisconnect = undefined;
      this.onMessage = undefined;
      this.sockId = null;
      this.server = null; // { address, port }
      this.local = null; // { address, port }
      this.contactAddr = null; // "ip:porta" anunciado no Contact
      this.pending = new Map(); // branch -> timer de retransmissão
      this.finals = new Map(); // Call-ID -> última resposta final de erro a um INVITE
      this.unsub = [];
      this.keepalive = null;
    }

    get state() {
      return this._state;
    }

    _setState(s, err) {
      if (this._state === s) return;
      this._state = s;
      this.stateChange.emit(s);
      if (s === TransportState.Connected) this.onConnect?.();
      if (s === TransportState.Disconnected) this.onDisconnect?.(err);
    }

    isConnected() {
      return this._state === TransportState.Connected;
    }

    async connect() {
      if (this.isConnected()) return;
      this._setState(TransportState.Connecting);
      const a = this.opts.account;
      try {
        const [host, portStr] = splitHostPort(a.proxy || a.domain);
        this.server = await net.resolve({ host, port: portStr ? Number(portStr) : 0, transport: this.protocol });
        if (this.protocol === 'UDP') {
          const { id, port } = await net.udpOpen({ port: 0 });
          this.sockId = id;
          const ip = await net.localAddress(this.server);
          this.local = { address: ip, port };
        } else {
          const r = await net.streamConnect({
            host: this.server.address,
            port: this.server.port,
            secure: this.protocol === 'TLS',
            servername: host,
            verify: a.tlsVerify !== false,
          });
          this.sockId = r.id;
          this.local = { address: r.localAddress, port: r.localPort };
        }
        this.contactAddr = `${this.local.address}:${this.local.port}`;
        this.unsub.push(
          net.onMessage((id, data, rinfo) => {
            if (id !== this.sockId) return;
            // Segurança: em UDP só aceita SIP vindo do próprio servidor/proxy. Bloqueia "chamadas
            // fantasma" de scanners que mandam INVITE direto para a porta aberta no NAT.
            if (this.protocol === 'UDP' && rinfo?.address && rinfo.address !== this.server.address) {
              this.dropped = (this.dropped || 0) + 1;
              if (this.dropped <= 5 || this.dropped % 100 === 0) {
                log(`${this.opts.account.name || this.opts.account.user} BLOQUEADO: SIP de origem desconhecida ${rinfo.address}:${rinfo.port} (${this.dropped} no total)`);
              }
              return;
            }
            this._receive(data);
          })
        );
        this.unsub.push(
          net.onClose((id) => {
            if (id !== this.sockId) return;
            this._cleanup();
            this._setState(TransportState.Disconnected, new Error('Conexão encerrada pelo servidor'));
          })
        );
        if (this.protocol === 'UDP') {
          // Mantém o mapeamento NAT aberto (como o Linphone).
          this.keepalive = setInterval(() => this._raw('\r\n\r\n'), 25000);
        }
        log(`${a.name || a.user} conectado: local ${this.local.address}:${this.local.port} -> servidor ${this.server.address}:${this.server.port} (${this.protocol})`);
        this._setState(TransportState.Connected);
      } catch (err) {
        this._cleanup();
        this._setState(TransportState.Disconnected, err);
        throw err;
      }
    }

    _cleanup() {
      clearInterval(this.keepalive);
      this.keepalive = null;
      for (const t of this.pending.values()) clearTimeout(t.timer);
      this.pending.clear();
      this.unsub.forEach((f) => f());
      this.unsub = [];
      if (this.sockId != null) net.close(this.sockId);
      this.sockId = null;
    }

    async disconnect() {
      this._cleanup();
      this._setState(TransportState.Disconnected);
    }

    async dispose() {
      await this.disconnect();
    }

    _raw(text) {
      if (this.sockId == null) return;
      if (this.protocol === 'UDP') net.udpSend(this.sockId, new TextEncoder().encode(text), this.server.port, this.server.address);
      else net.streamSend(this.sockId, text);
    }

    send(message) {
      if (!this.isConnected()) return Promise.reject(new Error('Transporte desconectado'));
      const vh = this.opts.viaHost;
      const via = `${this.local.address}:${this.local.port}`;
      // Via com o endereço local; Contact com o endereço público (quando detectado).
      let out = message.replace(new RegExp(`^(Via:\\s*SIP/2\\.0/\\w+\\s+)${escapeRe(vh)}`, 'im'), `$1${via}`);
      out = out.split(vh).join(this.contactAddr);
      out = fixContentLength(out);
      log(`${this.opts.account.name || this.opts.account.user} ENVIADO para ${this.server.address}:${this.server.port} (${this.protocol})`, out);
      this._raw(out);
      if (this.protocol === 'UDP' && /^[A-Z]+ /.test(out) && !out.startsWith('ACK ')) this._retransmit(out);
      return Promise.resolve();
    }

    _retransmit(msg) {
      const branch = branchOf(topVia(msg));
      if (!branch) return;
      const isInvite = msg.startsWith('INVITE ');
      const entry = { interval: T1, elapsed: 0, timer: null };
      const fire = () => {
        entry.elapsed += entry.interval;
        if (entry.elapsed >= 32000 || !this.pending.has(branch)) {
          this.pending.delete(branch);
          return;
        }
        this._raw(msg);
        entry.interval = isInvite ? entry.interval * 2 : Math.min(entry.interval * 2, T2);
        entry.timer = setTimeout(fire, entry.interval);
      };
      entry.timer = setTimeout(fire, entry.interval);
      this.pending.set(branch, entry);
    }

    _receive(data) {
      let msg = typeof data === 'string' ? data : new TextDecoder().decode(data);
      if (!msg.trim()) return; // pong do keep-alive
      log(`${this.opts.account.name || this.opts.account.user} RECEBIDO (${this.protocol})`, msg);
      if (msg.startsWith('SIP/2.0 ')) {
        const via = topVia(msg);
        const branch = branchOf(via);
        const p = this.pending.get(branch);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(branch);
        }
        this._learnPublicAddress(msg, via);
        this._rememberFinal(msg);
        // O SIP.js exige que o Via da resposta tenha exatamente o viaHost, sem porta.
        msg = msg.replace(
          /^((?:Via|v)\s*:\s*SIP\/2\.0\/\w+\s+)([^;\s,]+)/im,
          (_m, pre) => pre + this.opts.viaHost
        );
      } else if (/^CANCEL /.test(msg) === false && /^[A-Z]+ /.test(msg)) {
        // requisição recebida: nada a ajustar
      }
      try {
        this.onMessage?.(msg);
      } catch (err) {
        this.logger?.error?.(String(err));
      }
    }

    // Guarda o motivo de recusas (>= 300) de INVITE: após o desafio de autenticação (401/407) o SIP.js
    // reenvia o INVITE e o delegate original não recebe a resposta final.
    _rememberFinal(msg) {
      const m = msg.match(/^SIP\/2\.0 (\d{3}) ([^\r\n]*)/);
      const c = cseqOf(msg);
      if (!m || !c || c[2].toUpperCase() !== 'INVITE') return;
      const code = Number(m[1]);
      if (code < 300 || code === 401 || code === 407) return;
      const callId = msg.match(/^(?:call-id|i)\s*:\s*([^\r\n]+)/im)?.[1]?.trim();
      if (!callId) return;
      const q850 = msg.match(/^Reason\s*:\s*Q\.850\s*;\s*cause=(\d+)/im)?.[1];
      this.finals.set(callId, { code, reason: m[2].trim(), q850: q850 ? Number(q850) : null });
      if (this.finals.size > 50) this.finals.delete(this.finals.keys().next().value);
    }

    // Usa received/rport da resposta ao REGISTER para descobrir o endereço público.
    _learnPublicAddress(msg, via) {
      if (this.protocol !== 'UDP' || this.opts.account.natDetect === false) return;
      const c = cseqOf(msg);
      if (!c || c[2].toUpperCase() !== 'REGISTER') return;
      const received = via.match(/;\s*received=([^;\s,]+)/i)?.[1];
      const rport = via.match(/;\s*rport=(\d+)/i)?.[1];
      if (!received && !rport) return;
      const addr = `${received || this.local.address}:${rport || this.local.port}`;
      if (addr !== this.contactAddr) {
        this.contactAddr = addr;
        this.opts.onPublicAddress?.(addr);
      }
    }

    get mediaAddress() {
      return this.local?.address || '127.0.0.1';
    }
  };
}

function splitHostPort(s) {
  const v = String(s || '').replace(/^sips?:/i, '').trim();
  const m = v.match(/^\[([^\]]+)\](?::(\d+))?$/) || v.match(/^([^:]+)(?::(\d+))?$/);
  return m ? [m[1], m[2]] : [v, undefined];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Após trocar textos no cabeçalho, o Content-Length continua válido (só o cabeçalho muda),
// mas garantimos que corresponde ao corpo em bytes.
function fixContentLength(msg) {
  const i = msg.indexOf('\r\n\r\n');
  if (i < 0) return msg;
  const body = msg.slice(i + 4);
  const len = new TextEncoder().encode(body).length;
  return msg.slice(0, i).replace(/^(Content-Length|l)\s*:\s*\d+/im, `$1: ${len}`) + msg.slice(i);
}
