// Codecs de voz disponíveis por linha. O motor de áudio trabalha em 16 kHz (quadros de 20 ms = 320 amostras);
// cada codec converte de/para a sua taxa.
import { encode as g711Encode, decode as g711Decode } from './g711.js';
import { G722Encoder, G722Decoder } from './g722.js';

export const FRAME = 320; // 20 ms a 16 kHz

export const CODECS = {
  opus: { label: 'Opus', short: 'Opus', desc: 'Alta qualidade (até 48 kHz), resiste a perda de pacotes', rtpmap: 'opus/48000/2', clock: 48000, pt: 111, fmtp: 'useinbandfec=1;minptime=10' },
  G722: { label: 'G.722', short: 'G.722', desc: 'Voz em HD (16 kHz), 64 kbit/s', rtpmap: 'G722/8000', clock: 8000, pt: 9 },
  PCMA: { label: 'G.711 A-law (PCMA)', short: 'PCMA', desc: 'Padrão das operadoras no Brasil', rtpmap: 'PCMA/8000', clock: 8000, pt: 8 },
  PCMU: { label: 'G.711 µ-law (PCMU)', short: 'PCMU', desc: 'Padrão na América do Norte', rtpmap: 'PCMU/8000', clock: 8000, pt: 0 },
};

export const DEFAULT_CODECS = [
  { id: 'PCMA', on: true },
  { id: 'PCMU', on: true },
  { id: 'G722', on: true },
  { id: 'opus', on: false },
];

// Garante a lista completa (codecs novos entram desativados no fim).
export function normalizeCodecs(list) {
  const out = (Array.isArray(list) ? list : DEFAULT_CODECS).filter((c) => CODECS[c.id]).map((c) => ({ id: c.id, on: !!c.on }));
  for (const c of DEFAULT_CODECS) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, on: false });
  return out;
}

export const enabledCodecs = (list) => normalizeCodecs(list).filter((c) => c.on).map((c) => c.id);

// Identifica o codec de um rtpmap ("PCMA/8000", "opus/48000/2"...).
export function codecIdFromRtpmap(enc) {
  const name = String(enc || '').split('/')[0].toUpperCase();
  if (name === 'OPUS') return 'opus';
  return CODECS[name] ? name : null;
}

const STATIC_PT = { 0: 'PCMU', 8: 'PCMA', 9: 'G722' };
export const staticCodec = (pt) => STATIC_PT[pt] || null;

// Suporte a Opus depende do WebCodecs do Chromium (presente no Electron).
export const opusSupported = () => typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';

/* ---------- Conversões de taxa ---------- */

function down2(pcm, state) {
  // 16 kHz -> 8 kHz com filtro [1/4, 1/2, 1/4]
  const out = new Float32Array(pcm.length >> 1);
  let prev = state.prev;
  for (let i = 0; i < out.length; i++) {
    const a = pcm[2 * i];
    const b = pcm[2 * i + 1];
    out[i] = prev * 0.25 + a * 0.5 + b * 0.25;
    prev = b;
  }
  state.prev = prev;
  return out;
}

function up2(pcm, state) {
  // 8 kHz -> 16 kHz por interpolação linear
  const out = new Float32Array(pcm.length * 2);
  let prev = state.prev;
  for (let i = 0; i < pcm.length; i++) {
    out[2 * i] = (prev + pcm[i]) * 0.5;
    out[2 * i + 1] = pcm[i];
    prev = pcm[i];
  }
  state.prev = prev;
  return out;
}

function resample(pcm, from, to) {
  if (from === to) return pcm;
  const n = Math.round((pcm.length * to) / from);
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const k = Math.floor(p);
    const f = p - k;
    out[i] = (pcm[k] ?? 0) * (1 - f) + (pcm[k + 1] ?? pcm[k] ?? 0) * f;
  }
  return out;
}

const toInt16 = (f) => {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = f[i] >= 1 ? 32767 : f[i] <= -1 ? -32768 : Math.round(f[i] * 32767);
  return o;
};
const toFloat = (i16) => {
  const o = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) o[i] = i16[i] / 32768;
  return o;
};

/* ---------- Instâncias ---------- */

// encode(pcm16k, onBytes) e decode(bytes, onPcm16k) usam callbacks porque o Opus é assíncrono.
export function createCodec(id) {
  const info = CODECS[id];
  const tsInc = info.clock / 50; // incremento do timestamp RTP por quadro de 20 ms

  if (id === 'PCMA' || id === 'PCMU') {
    const pt = id === 'PCMA' ? 8 : 0;
    const ds = { prev: 0 };
    const us = { prev: 0 };
    return {
      id,
      tsInc,
      encode: (pcm, cb) => cb(g711Encode(pt, down2(pcm, ds))),
      decode: (bytes, cb) => cb(up2(g711Decode(pt, bytes), us)),
      close() {},
    };
  }

  if (id === 'G722') {
    const enc = new G722Encoder();
    const dec = new G722Decoder();
    return {
      id,
      tsInc, // G.722 anuncia relógio de 8 kHz no RTP (RFC 3551), apesar de amostrar a 16 kHz
      encode: (pcm, cb) => cb(enc.encode(toInt16(pcm))),
      decode: (bytes, cb) => cb(toFloat(dec.decode(bytes))),
      close() {},
    };
  }

  if (id === 'opus') {
    let onBytes = null;
    let onPcm = null;
    let t = 0;
    let rt = 0;
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        onBytes?.(b);
      },
      error: (e) => console.warn('Opus (codificação):', e),
    });
    encoder.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 32000, opus: { frameDuration: 20000, useinbandfec: true } });
    const decoder = new AudioDecoder({
      output: (ad) => {
        const n = ad.numberOfFrames;
        const buf = new Float32Array(n);
        ad.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
        const sr = ad.sampleRate;
        ad.close();
        onPcm?.(resample(buf, sr, 16000));
      },
      error: (e) => console.warn('Opus (decodificação):', e),
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    return {
      id,
      tsInc,
      encode(pcm, cb) {
        onBytes = cb;
        if (encoder.state !== 'configured') return;
        encoder.encode(new AudioData({ format: 'f32', sampleRate: 16000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: t, data: pcm }));
        t += 20000;
      },
      decode(bytes, cb) {
        onPcm = cb;
        if (decoder.state !== 'configured') return;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: rt, data: bytes }));
        rt += 20000;
      },
      close() {
        try {
          encoder.close();
          decoder.close();
        } catch {
          /* já fechado */
        }
      },
    };
  }
  throw new Error(`Codec não suportado: ${id}`);
}
