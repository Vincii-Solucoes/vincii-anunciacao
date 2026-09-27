// Sessão RTP de um canal de áudio: empacota/desempacota G.711 e DTMF (RFC 4733).
import { encode, decode } from './g711.js';

const DTMF_EVENTS = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15 };
const rand32 = () => (Math.random() * 0x100000000) >>> 0;

export class RtpStream {
  constructor(bridge, socketId, localPort) {
    this.bridge = bridge;
    this.socketId = socketId;
    this.localPort = localPort;
    this.remote = null; // { address, port }
    this.pt = 8;
    this.dtmfPt = 101;
    this.send = true;
    this.ssrc = rand32();
    this.seq = rand32() & 0xffff;
    this.ts = rand32();
    this.first = true;
    this.lastRxSeq = null;
    this.latched = false;
    this.onAudio = null; // (Float32Array) => void
    this.lastRx = 0;
    this.stats = { tx: 0, rx: 0 };
    this.dtmfBusy = Promise.resolve();
  }

  configure({ address, port, pt, dtmfPt, send }) {
    if (!this.latched || !this.remote) this.remote = { address, port };
    if (pt != null) this.pt = pt;
    this.dtmfPt = dtmfPt ?? this.dtmfPt;
    this.send = send;
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

  // pcm: Float32Array de 160 amostras (20 ms a 8 kHz)
  sendAudio(pcm) {
    if (!this.send) {
      this.ts = (this.ts + pcm.length) >>> 0;
      return;
    }
    const payload = encode(this.pt, pcm);
    const pkt = new Uint8Array(12 + payload.length);
    pkt.set(this._header(this.pt, this.first, this.ts));
    pkt.set(payload, 12);
    this.first = false;
    this.ts = (this.ts + pcm.length) >>> 0;
    this._out(pkt);
  }

  sendDtmf(digit, durationMs = 160) {
    const ev = DTMF_EVENTS[String(digit).toUpperCase()];
    if (ev == null) return;
    this.dtmfBusy = this.dtmfBusy.then(
      () =>
        new Promise((resolve) => {
          const ts = this.ts;
          const steps = Math.max(3, Math.round(durationMs / 20));
          let i = 0;
          const tick = () => {
            i++;
            const end = i >= steps;
            const dur = Math.min(i * 160, 0xffff);
            const body = new Uint8Array([ev, (end ? 0x80 : 0) | 10, dur >> 8, dur & 0xff]);
            const reps = end ? 3 : 1; // pacote final enviado 3x
            for (let r = 0; r < reps; r++) {
              const pkt = new Uint8Array(16);
              pkt.set(this._header(this.dtmfPt, i === 1 && r === 0, ts));
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
    // RTP simétrico: responde para onde o áudio realmente vem (atravessa NAT).
    if (!this.latched || this.remote?.address !== rinfo.address || this.remote?.port !== rinfo.port) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      this.latched = true;
    }
    this.lastRx = Date.now();
    this.stats.rx++;
    if (pt !== 0 && pt !== 8) return; // DTMF recebido e outros payloads são ignorados
    const seq = (b[2] << 8) | b[3];
    if (this.lastRxSeq != null) {
      const diff = (seq - this.lastRxSeq) & 0xffff;
      if (diff === 0 || diff > 0x8000) return; // duplicado ou atrasado
    }
    this.lastRxSeq = seq;
    const cc = b[0] & 0x0f;
    let off = 12 + cc * 4;
    if (b[0] & 0x10) off += 4 + (((b[off + 2] << 8) | b[off + 3]) * 4);
    let end = b.length;
    if (b[0] & 0x20) end -= b[b.length - 1];
    if (end <= off) return;
    this.onAudio?.(decode(pt, b.subarray(off, end)));
  }
}
