// Codec G.722 (64 kbit/s, áudio de 16 kHz) — porte do algoritmo de referência ITU-T
// (mesma estrutura da implementação de domínio público de Steve Underwood / spandsp).

const QMF = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];
const Q6 = [0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714, 786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557, 2919, 0, 0];
const ILN = [0, 63, 62, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 0];
const ILP = [0, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 0];
const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const ILB = [2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834, 2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371, 3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008];
const QM4 = [0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968, 6288, 4240, 2584, 1200, 0];
const QM2 = [-7408, -1616, 7408, 1616];
const QM6 = [
  -136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
  -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576, -3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
  24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192, 10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
  4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136,
];
const IHN = [0, 1, 0];
const IHP = [0, 3, 2];
const WH = [0, -214, 798];
const RH2 = [2, 1, 2, 1];

const sat = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

function band() {
  return { s: 0, sp: 0, sz: 0, r: [0, 0, 0], a: [0, 0, 0], ap: [0, 0, 0], p: [0, 0, 0], d: [0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0], bp: [0, 0, 0, 0, 0, 0, 0], sg: [0, 0, 0, 0, 0, 0, 0], nb: 0, det: 0 };
}

// Blocos 4L/4H: preditor adaptativo.
function block4(b, d) {
  b.d[0] = d;
  b.r[0] = sat(b.s + d);
  b.p[0] = sat(b.sz + d);

  for (let i = 0; i < 3; i++) b.sg[i] = b.p[i] >> 15;
  let wd1 = sat(b.a[1] << 2);
  let wd2 = b.sg[0] === b.sg[1] ? -wd1 : wd1;
  if (wd2 > 32767) wd2 = 32767;
  let wd3 = (wd2 >> 7) + (b.sg[0] === b.sg[2] ? 128 : -128);
  wd3 += (b.a[2] * 32512) >> 15;
  if (wd3 > 12288) wd3 = 12288;
  else if (wd3 < -12288) wd3 = -12288;
  b.ap[2] = wd3;

  b.sg[0] = b.p[0] >> 15;
  b.sg[1] = b.p[1] >> 15;
  wd1 = b.sg[0] === b.sg[1] ? 192 : -192;
  wd2 = (b.a[1] * 32640) >> 15;
  b.ap[1] = sat(wd1 + wd2);
  wd3 = sat(15360 - b.ap[2]);
  if (b.ap[1] > wd3) b.ap[1] = wd3;
  else if (b.ap[1] < -wd3) b.ap[1] = -wd3;

  wd1 = d === 0 ? 0 : 128;
  b.sg[0] = d >> 15;
  for (let i = 1; i < 7; i++) {
    b.sg[i] = b.d[i] >> 15;
    wd2 = b.sg[i] === b.sg[0] ? wd1 : -wd1;
    wd3 = (b.b[i] * 32640) >> 15;
    b.bp[i] = sat(wd2 + wd3);
  }

  for (let i = 6; i > 0; i--) {
    b.d[i] = b.d[i - 1];
    b.b[i] = b.bp[i];
  }
  for (let i = 2; i > 0; i--) {
    b.r[i] = b.r[i - 1];
    b.p[i] = b.p[i - 1];
    b.a[i] = b.ap[i];
  }

  wd1 = sat(b.r[1] + b.r[1]);
  wd1 = (b.a[1] * wd1) >> 15;
  wd2 = sat(b.r[2] + b.r[2]);
  wd2 = (b.a[2] * wd2) >> 15;
  b.sp = sat(wd1 + wd2);

  let sz = 0;
  for (let i = 6; i > 0; i--) {
    wd1 = sat(b.d[i] + b.d[i]);
    sz += (b.b[i] * wd1) >> 15;
  }
  b.sz = sat(sz);
  b.s = sat(b.sp + b.sz);
}

function scale(nb, shift) {
  const wd1 = (nb >> 6) & 31;
  const wd2 = shift - (nb >> 11);
  const wd3 = wd2 < 0 ? ILB[wd1] << -wd2 : ILB[wd1] >> wd2;
  return wd3 << 2;
}

export class G722Encoder {
  constructor() {
    this.x = new Int32Array(24);
    this.band = [band(), band()];
    this.band[0].det = 32;
    this.band[1].det = 8;
  }

  // pcm: Int16Array a 16 kHz (tamanho par) -> bytes G.722 (metade do tamanho)
  encode(pcm) {
    const out = new Uint8Array(pcm.length >> 1);
    const [lo, hi] = this.band;
    const x = this.x;
    for (let j = 0, k = 0; j < pcm.length; k++) {
      x.copyWithin(0, 2);
      x[22] = pcm[j++];
      x[23] = pcm[j++];
      let sumeven = 0;
      let sumodd = 0;
      for (let i = 0; i < 12; i++) {
        sumodd += x[2 * i] * QMF[i];
        sumeven += x[2 * i + 1] * QMF[11 - i];
      }
      const xlow = (sumeven + sumodd) >> 14;
      const xhigh = (sumeven - sumodd) >> 14;

      // Banda baixa
      const el = sat(xlow - lo.s);
      let wd = el >= 0 ? el : -(el + 1);
      let i = 1;
      for (; i < 30; i++) if (wd < (Q6[i] * lo.det) >> 12) break;
      const ilow = el < 0 ? ILN[i] : ILP[i];
      const ril = ilow >> 2;
      const dlow = (lo.det * QM4[ril]) >> 15;
      let nb = ((lo.nb * 127) >> 7) + WL[RL42[ril]];
      lo.nb = nb < 0 ? 0 : nb > 18432 ? 18432 : nb;
      lo.det = scale(lo.nb, 8);
      block4(lo, dlow);

      // Banda alta
      const eh = sat(xhigh - hi.s);
      wd = eh >= 0 ? eh : -(eh + 1);
      const mih = wd >= (564 * hi.det) >> 12 ? 2 : 1;
      const ihigh = eh < 0 ? IHN[mih] : IHP[mih];
      const dhigh = (hi.det * QM2[ihigh]) >> 15;
      nb = ((hi.nb * 127) >> 7) + WH[RH2[ihigh]];
      hi.nb = nb < 0 ? 0 : nb > 22528 ? 22528 : nb;
      hi.det = scale(hi.nb, 10);
      block4(hi, dhigh);

      out[k] = ((ihigh << 6) | ilow) & 0xff;
    }
    return out;
  }
}

export class G722Decoder {
  constructor() {
    this.x = new Int32Array(24);
    this.band = [band(), band()];
    this.band[0].det = 32;
    this.band[1].det = 8;
  }

  // bytes G.722 -> Int16Array a 16 kHz (dobro do tamanho)
  decode(bytes) {
    const out = new Int16Array(bytes.length * 2);
    const [lo, hi] = this.band;
    const x = this.x;
    let o = 0;
    for (let j = 0; j < bytes.length; j++) {
      const code = bytes[j];
      let wd1 = code & 0x3f;
      const ihigh = (code >> 6) & 0x03;

      // Banda baixa
      let wd2 = (lo.det * QM6[wd1]) >> 15;
      let rlow = lo.s + wd2;
      rlow = rlow > 16383 ? 16383 : rlow < -16384 ? -16384 : rlow;
      wd1 >>= 2;
      const dlowt = (lo.det * QM4[wd1]) >> 15;
      let nb = ((lo.nb * 127) >> 7) + WL[RL42[wd1]];
      lo.nb = nb < 0 ? 0 : nb > 18432 ? 18432 : nb;
      lo.det = scale(lo.nb, 8);
      block4(lo, dlowt);

      // Banda alta
      const dhigh = (hi.det * QM2[ihigh]) >> 15;
      let rhigh = dhigh + hi.s;
      rhigh = rhigh > 16383 ? 16383 : rhigh < -16384 ? -16384 : rhigh;
      nb = ((hi.nb * 127) >> 7) + WH[RH2[ihigh]];
      hi.nb = nb < 0 ? 0 : nb > 22528 ? 22528 : nb;
      hi.det = scale(hi.nb, 10);
      block4(hi, dhigh);

      // QMF de recepção
      x.copyWithin(0, 2);
      x[22] = rlow + rhigh;
      x[23] = rlow - rhigh;
      let xout1 = 0;
      let xout2 = 0;
      for (let i = 0; i < 12; i++) {
        xout2 += x[2 * i] * QMF[i];
        xout1 += x[2 * i + 1] * QMF[11 - i];
      }
      out[o++] = sat(xout1 >> 11);
      out[o++] = sat(xout2 >> 11);
    }
    return out;
  }
}
