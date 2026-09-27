// Processador de áudio em tempo real: captura do microfone, reamostragem 48k<->16k,
// buffer de jitter por chamada e mixagem de conferência.
const RATE = 16000; // taxa interna (banda larga)
const FRAME = 320; // 20 ms

class Resampler {
  // Reamostragem linear com filtro passa-baixa simples na redução.
  constructor(from, to) {
    this.ratio = from / to;
    this.pos = 0;
    this.prev = 0;
    this.lp = 0;
    this.lp2 = 0;
    this.alpha = to < from ? Math.min(1, (2 * Math.PI * (to * 0.45)) / from) : 1;
  }
  push(input, out) {
    for (let i = 0; i < input.length; i++) {
      this.lp += this.alpha * (input[i] - this.lp);
      const x = (this.lp2 += this.alpha * (this.lp - this.lp2));
      while (this.pos <= 1) {
        out.push(this.prev + (x - this.prev) * this.pos);
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = x;
    }
  }
}

class Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.down = new Resampler(sampleRate, RATE);
    this.micBuf = [];
    this.out = new Float32Array(sampleRate); // fila circular de saída
    this.outR = 0;
    this.outW = 0;
    this.outLen = 0;
    this.up = new Resampler(RATE, sampleRate);
    this.calls = new Map(); // id -> { q: number[], started, muted, held, conf, rec, level }
    this.port.onmessage = (e) => this.onMsg(e.data);
    this.tick = 0;
  }

  onMsg(m) {
    if (m.type === 'add') this.calls.set(m.id, { q: [], started: false, muted: false, held: false, conf: false, active: false, early: false });
    else if (m.type === 'remove') this.calls.delete(m.id);
    else if (m.type === 'state') {
      const c = this.calls.get(m.id);
      if (c) Object.assign(c, m.state);
    } else if (m.type === 'rx') {
      const c = this.calls.get(m.id);
      if (!c) return;
      const pcm = m.pcm;
      for (let i = 0; i < pcm.length; i++) c.q.push(pcm[i]);
      if (c.q.length > 4800) c.q.splice(0, c.q.length - 1600); // atraso > 300 ms: descarta excesso
    }
  }

  popRx(c) {
    // Pré-carrega 60 ms antes de começar a tocar (absorve jitter da rede).
    if (!c.started) {
      if (c.q.length < 960) return null;
      c.started = true;
    }
    if (c.q.length < FRAME) {
      c.started = false;
      return null;
    }
    return Float32Array.from(c.q.splice(0, FRAME));
  }

  frame(mic) {
    const rx = new Map();
    for (const [id, c] of this.calls) {
      const f = c.active ? this.popRx(c) : null;
      if (f && !c.held) rx.set(id, f);
    }
    // Alto-falante: soma de todas as chamadas audíveis.
    const play = new Float32Array(FRAME);
    for (const f of rx.values()) for (let i = 0; i < FRAME; i++) play[i] += f[i];

    const tx = [];
    const transfer = [];
    for (const [id, c] of this.calls) {
      if (!c.active || c.held) continue;
      const out = new Float32Array(FRAME);
      // Antes do atendimento (early media) envia silêncio: mantém o RTP fluindo pelo NAT
      // sem transmitir o microfone.
      if (!c.muted && !c.early) out.set(mic);
      if (c.conf) {
        for (const [oid, f] of rx) {
          if (oid === id || !this.calls.get(oid)?.conf) continue;
          for (let i = 0; i < FRAME; i++) out[i] += f[i];
        }
      }
      for (let i = 0; i < FRAME; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
      tx.push({ id, pcm: out });
      transfer.push(out.buffer);
    }
    if (tx.length) this.port.postMessage({ type: 'frames', tx }, transfer);

    // Reamostra para a saída.
    const up = [];
    this.up.push(play, up);
    for (const s of up) {
      if (this.outLen >= this.out.length) break;
      this.out[this.outW] = s;
      this.outW = (this.outW + 1) % this.out.length;
      this.outLen++;
    }
    // Nível do microfone para o medidor da interface (a cada ~200 ms).
    if (++this.tick % 10 === 0) {
      let peak = 0;
      for (let i = 0; i < FRAME; i++) peak = Math.max(peak, Math.abs(mic[i]));
      this.port.postMessage({ type: 'level', mic: peak });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0][0];
    const n = output.length;
    const samples = [];
    this.down.push(input && input.length ? input : new Float32Array(n), samples);
    for (const s of samples) this.micBuf.push(s);
    while (this.micBuf.length >= FRAME) this.frame(Float32Array.from(this.micBuf.splice(0, FRAME)));

    // Mantém a latência de saída baixa: se acumular > 150 ms, descarta.
    const maxLen = Math.round(sampleRate * 0.15);
    while (this.outLen > maxLen) {
      this.outR = (this.outR + 1) % this.out.length;
      this.outLen--;
    }
    for (let i = 0; i < n; i++) {
      if (this.outLen > 0) {
        output[i] = this.out[this.outR];
        this.outR = (this.outR + 1) % this.out.length;
        this.outLen--;
      } else output[i] = 0;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(output);
    return true;
  }
}

registerProcessor('vincii-engine', Engine);
