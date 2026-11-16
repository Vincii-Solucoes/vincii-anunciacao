// Toques gerados via WebAudio (sem arquivos de áudio).
import { listDevices, resolveDevice } from './media/devices.js';
import { log } from './log.js';
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

// Dispositivo do toque ('' = padrão do sistema). Se o escolhido não estiver conectado, usa o padrão.
let ringerSink = '';
export async function setRingerDevice(id) {
  ringerSink = id || '';
  const c = ensureCtx();
  if (!c?.setSinkId) return;
  const target = resolveDevice(await listDevices(), 'audiooutput', ringerSink, 'ring');
  await c.setSinkId(target).catch(() => {});
}

// Toca o toque uma vez (botão "Testar") e devolve { device, error }.
export async function testRinger(chosen = ringerSink) {
  const c = ensureCtx();
  if (!c) return { device: '?', error: 'WebAudio indisponível' };
  const devices = await listDevices();
  const target = resolveDevice(devices, 'audiooutput', chosen, 'ring');
  const device = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === (target || 'default'))?.label || target || 'padrão';
  try {
    if (c.state !== 'running') await c.resume();
    if (c.setSinkId) await c.setSinkId(target);
    PATTERNS.ring.play(c.currentTime + 0.02);
    log(`ÁUDIO teste do toque em "${device}": ok (estado ${c.state}, sinkId ${c.sinkId || 'padrão'})`);
    return { device, error: null };
  } catch (e) {
    log(`ÁUDIO teste do toque em "${device}" falhou: ${e.name} ${e.message}`);
    return { device, error: `${e.name}: ${e.message}` };
  } finally {
    setTimeout(() => setRingerDevice(ringerSink), 2000);
  }
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
