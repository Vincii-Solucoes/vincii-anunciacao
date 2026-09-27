// Codecs G.711 (PCMU µ-law / PCMA A-law) com tabelas pré-calculadas.
const MULAW_DEC = new Int16Array(256);
const ALAW_DEC = new Int16Array(256);

for (let i = 0; i < 256; i++) {
  let u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  MULAW_DEC[i] = u & 0x80 ? 0x84 - t : t - 0x84;

  let a = i ^ 0x55;
  let v = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) v += 8;
  else if (seg === 1) v += 0x108;
  else v = (v + 0x108) << (seg - 1);
  ALAW_DEC[i] = a & 0x80 ? v : -v;
}

function mulawEncode(s) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const man = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | man) & 0xff;
}

function alawEncode(s) {
  let sign = 0;
  if (s < 0) {
    s = -s - 1;
    sign = 0x80;
  }
  if (s > 32767) s = 32767;
  let enc;
  if (s < 256) enc = s >> 4;
  else {
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 1; exp--, mask >>= 1);
    enc = (exp << 4) | ((s >> (exp + 3)) & 0x0f);
  }
  return (enc | sign) ^ 0xd5;
}

const MULAW_ENC = new Uint8Array(65536);
const ALAW_ENC = new Uint8Array(65536);
for (let i = -32768; i < 32768; i++) {
  MULAW_ENC[i & 0xffff] = mulawEncode(i);
  ALAW_ENC[i & 0xffff] = alawEncode(i);
}

const toInt = (f) => (f >= 1 ? 32767 : f <= -1 ? -32768 : Math.round(f * 32767));

export const CODECS = {
  0: { name: 'PCMU', enc: MULAW_ENC, dec: MULAW_DEC },
  8: { name: 'PCMA', enc: ALAW_ENC, dec: ALAW_DEC },
};

export function encode(pt, pcm) {
  const t = CODECS[pt].enc;
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = t[toInt(pcm[i]) & 0xffff];
  return out;
}

export function decode(pt, bytes) {
  const t = CODECS[pt].dec;
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = t[bytes[i]] / 32768;
  return out;
}
