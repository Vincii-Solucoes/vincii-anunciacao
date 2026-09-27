// Toques gerados via WebAudio (sem arquivos de áudio).
let ctx = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Navegadores só liberam áudio após um gesto do usuário.
export function unlockAudio() {
  ensureCtx();
}

function tone(freq, start, dur, gain = 0.12) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

const PATTERNS = {
  // Toque principal: arpejo curto, repetido.
  ring: {
    every: 3000,
    play(t) {
      [0, 1].forEach((r) => {
        tone(784, t + r, 0.16);
        tone(988, t + r + 0.18, 0.16);
        tone(1175, t + r + 0.36, 0.28);
      });
    },
  },
  // Tom de chamada (ringback) brasileiro: 425 Hz, 1 s ligado / 4 s desligado.
  ringback: {
    every: 5000,
    play(t) {
      tone(425, t, 1, 0.06);
    },
  },
  // Chamada em espera: dois bipes discretos (425 Hz, padrão brasileiro).
  waiting: {
    every: 4000,
    play(t) {
      tone(425, t, 0.15, 0.08);
      tone(425, t + 0.3, 0.15, 0.08);
    },
  },
};

let mode = null;
let timer = null;

export function setRinger(next) {
  if (next === mode) return;
  mode = next;
  clearInterval(timer);
  timer = null;
  if (!next || !ensureCtx()) return;
  const p = PATTERNS[next];
  const play = () => p.play(ctx.currentTime + 0.02);
  play();
  timer = setInterval(play, p.every);
}

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
};

export function dtmfTone(key) {
  const f = DTMF[key];
  if (!f || !ensureCtx()) return;
  const t = ctx.currentTime + 0.01;
  tone(f[0], t, 0.12, 0.05);
  tone(f[1], t, 0.12, 0.05);
}
