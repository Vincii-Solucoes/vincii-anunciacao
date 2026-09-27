// Sessão RTP de uma chamada: empacota/desempacota o codec negociado e DTMF (RFC 4733).
import { createCodec, CODECS } from './codecs.js';

const DTMF_EVENTS = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15 };
const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$)/.test(String(ip || ''));
const rand32 = () => (Math.random() * 0x100000000) >>> 0;

export class RtpStream {
  constructor(bridge, socketId, localPort) {
    this.bridge = bridge;
    this.socketId = socketId;
    this.localPort = localPort;
    this.remote = null; // { address, port }
    this.tx = null; // { codec, pt }
    this.rxMap = {}; // pt -> id do codec
    this.decoders = new Map(); // id -> instância
    this.dtmf = { pt: 101, clock: 8000 };
    this.send = true;
    this.ssrc = rand32();
    this.seq = rand32() & 0xffff;
    this.ts = rand32();
    this.first = true;
    this.lastRxSeq = null;
    this.latched = false;
    this.onAudio = null; // (Float32Array 16 kHz) => void
    this.stats = { tx: 0, rx: 0 };
    this.dtmfBusy = Promise.resolve();
  }

  // codec: id escolhido; pt: payload type para enviar; rxMap: payload types que podemos receber.
  configure({ address, port, codec, pt, rxMap, dtmf, send, server }) {
    if (!this.latched || !this.remote) this.remote = { address, port };
    // Origens aceitas para o áudio: o endereço do SDP e o do servidor SIP.
    this.allowed = new Set([address, server].filter(Boolean));
    this.sdpPrivate = isPrivate(address);
    if (!this.tx || this.tx.codec.id !== codec) {
      this.tx?.codec.close();
      this.tx = { codec: createCodec(codec), pt };
      this.first = true;
    } else this.tx.pt = pt;
    this.rxMap = { ...this.rxMap, ...rxMap };
    if (dtmf) this.dtmf = dtmf;
    this.send = send;
  }

  get codecId() {
    return this.tx?.codec.id || null;
  }

  _header(pt, marker, ts) {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    b[0] = 0x80;
    b[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
    v.setUint16(2, this.seq);
    v.setUint32(4, ts >>> 0);
    v.setUint32(8, this.ssrc);
    this.seq = (this.seq + 1) & 0xffff;
    return b;
  }

  _out(pkt) {
    if (!this.remote?.port || !this.remote.address || this.remote.address === '0.0.0.0') return;
    this.bridge.udpSend(this.socketId, pkt, this.remote.port, this.remote.address);
    this.stats.tx++;
  }

  // pcm: Float32Array de 320 amostras (20 ms a 16 kHz)
  sendAudio(pcm) {
    const tx = this.tx;
    if (!tx) return;
    if (!this.send) {
      this.ts = (this.ts + tx.codec.tsInc) >>> 0;
      return;
    }
    tx.codec.encode(pcm, (payload) => {
      const pkt = new Uint8Array(12 + payload.length);
      pkt.set(this._header(tx.pt, this.first, this.ts));
      pkt.set(payload, 12);
      this.first = false;
      this.ts = (this.ts + tx.codec.tsInc) >>> 0;
      this._out(pkt);
    });
  }

  sendDtmf(digit, durationMs = 160) {
    const ev = DTMF_EVENTS[String(digit).toUpperCase()];
    if (ev == null || !this.tx) return;
    const perFrame = this.dtmf.clock / 50;
    this.dtmfBusy = this.dtmfBusy.then(
      () =>
        new Promise((resolve) => {
          const ts = this.ts;
          const steps = Math.max(3, Math.round(durationMs / 20));
          let i = 0;
          const tick = () => {
            i++;
            const end = i >= steps;
            const dur = Math.min(i * perFrame, 0xffff);
            const body = new Uint8Array([ev, (end ? 0x80 : 0) | 10, dur >> 8, dur & 0xff]);
            for (let r = 0; r < (end ? 3 : 1); r++) {
              const pkt = new Uint8Array(16);
              pkt.set(this._header(this.dtmf.pt, i === 1 && r === 0, ts));
              pkt.set(body, 12);
              this._out(pkt);
            }
            if (end) setTimeout(resolve, 60);
            else setTimeout(tick, 20);
          };
          tick();
        })
    );
  }

  receive(data, rinfo) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (b.length < 12 || b[0] >> 6 !== 2) return;
    const pt = b[1] & 0x7f;
    if (pt >= 72 && pt <= 76) return; // RTCP
    // Segurança: só aceita áudio da origem negociada (evita injeção/sequestro de RTP).
    // Se o SDP trouxe um IP privado (PBX atrás de NAT), trava na primeira origem que chegar.
    const known = this.allowed?.has(rinfo.address) || (this.sdpPrivate && (!this.latched || rinfo.address === this.remote?.address));
    if (!known) {
      this.stats.dropped = (this.stats.dropped || 0) + 1;
      return;
    }
    // RTP simétrico: responde para onde o áudio realmente vem (atravessa NAT).
    if (!this.latched || this.remote?.address !== rinfo.address || this.remote?.port !== rinfo.port) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      this.latched = true;
    }
    this.stats.rx++;
    const id = this.rxMap[pt];
    if (!id || !CODECS[id]) return; // DTMF, conforto de ruído etc.
    const seq = (b[2] << 8) | b[3];
    if (this.lastRxSeq != null) {
      const diff = (seq - this.lastRxSeq) & 0xffff;
      if (diff === 0 || diff > 0x8000) return; // duplicado ou atrasado
    }
    this.lastRxSeq = seq;
    const cc = b[0] & 0x0f;
    let off = 12 + cc * 4;
    if (b[0] & 0x10) off += 4 + ((b[off + 2] << 8) | b[off + 3]) * 4;
    let end = b.length;
    if (b[0] & 0x20) end -= b[b.length - 1];
    if (end <= off) return;
    let dec = this.decoders.get(id);
    if (!dec) {
      dec = createCodec(id);
      this.decoders.set(id, dec);
    }
    dec.decode(b.slice(off, end), (pcm) => this.onAudio?.(pcm));
  }

  close() {
    this.tx?.codec.close();
    for (const d of this.decoders.values()) d.close();
    this.decoders.clear();
  }
}
