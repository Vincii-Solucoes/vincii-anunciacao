// Gera o ícone do app e os ícones da bandeja a partir do "V" do logotipo VINCII.
// Uso: node scripts/make-icons.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...a) => path.join(root, ...a);

// 1. Recorta o "V" (sem o texto) e remove as bordas transparentes.
const cropped = await sharp(p('public/logo.png')).extract({ left: 110, top: 110, width: 370, height: 256 }).png().toBuffer();
const mark = await sharp(cropped).trim({ threshold: 10 }).png().toBuffer(); // trim roda antes do extract no sharp
const meta = await sharp(mark).metadata();
await sharp(mark).toFile(p('public/mark.png'));

// 2. Ícone do aplicativo: o "V" da VINCII com um fone de telefone encaixado no vértice.
const S = 1024;
// Fone (Material Icons "call", Apache 2.0) + ondas de chamada, em coordenadas 24x24.
const HANDSET =
  'M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z';

function iconSvg({ inset, shadow }) {
  const x = inset, w = S - inset * 2, r = Math.round(w * 0.225);
  // Selo do telefone: canto inferior direito, sobrepondo o vértice do V.
  const cx = x + w * 0.69, cy = x + w * 0.69, R = w * 0.175;
  const g = (R * 1.12) / 18; // o glifo ocupa ~18 de 24 unidades
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1c1c"/><stop offset="1" stop-color="#040606"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.42" cy="0.22" r="0.8">
      <stop offset="0" stop-color="#00C9B1" stop-opacity="0.30"/>
      <stop offset="0.6" stop-color="#00C9B1" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#00C9B1" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7ff7ea" stop-opacity="0.45"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3ff0d9"/><stop offset="1" stop-color="#00a590"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="bglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${R * 0.18}"/></filter>
  </defs>
  ${shadow ? `<rect x="${x}" y="${x + 20}" width="${w}" height="${w}" rx="${r}" fill="#000" opacity="0.45" filter="url(#shadow)"/>` : ''}
  <rect x="${x}" y="${x}" width="${w}" height="${w}" rx="${r}" fill="url(#bg)"/>
  <rect x="${x}" y="${x}" width="${w}" height="${w}" rx="${r}" fill="url(#glow)"/>
  <rect x="${x + 1.5}" y="${x + 1.5}" width="${w - 3}" height="${w - 3}" rx="${r - 1}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  <g id="phone">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#00C9B1" opacity="0.55" filter="url(#bglow)"/>
    <circle cx="${cx}" cy="${cy}" r="${R + w * 0.022}" fill="#060d0d"/>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#badge)"/>
    <g transform="translate(${cx - 12 * g} ${cy - 12 * g}) scale(${g})">
      <path d="${HANDSET}" fill="#00211d"/>
      <path d="M14.6 3.3a6.6 6.6 0 0 1 6.1 6.1" fill="none" stroke="#00211d" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M14.3 6.6a3.4 3.4 0 0 1 3.1 3.1" fill="none" stroke="#00211d" stroke-width="1.7" stroke-linecap="round"/>
    </g>
  </g>
</svg>`);
}

const PAD = 70;
async function renderIcon({ inset, shadow, file, size }) {
  const w = S - inset * 2;
  const vW = Math.round(w * 0.6);
  const vH = Math.round((meta.height / meta.width) * vW);
  const vBig = await sharp(mark).resize({ width: vW, kernel: 'lanczos3' }).sharpen({ sigma: 0.6 }).png().toBuffer();
  // Brilho suave atrás do V (com margem para o desfoque não ser cortado).
  const vGlow = await sharp(vBig)
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(28)
    .png()
    .toBuffer();
  const left = Math.round(x0(inset) + w * 0.12);
  const top = Math.round(x0(inset) + w * 0.2);
  // Base + V; o selo do telefone vai por cima (segunda passada com só o grupo "phone").
  const base = iconSvg({ inset, shadow });
  const phoneOnly = Buffer.from(
    base.toString().replace(/<rect[^>]*\/>/g, '').replace(/<\/?filter[^]*?<\/filter>/g, (m) => m)
  );
  const withV = await sharp(base)
    .composite([
      { input: vGlow, left: left - PAD, top: top - PAD, blend: 'screen' },
      { input: vBig, left, top },
      { input: phoneOnly, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  await sharp(withV).resize(size || S).png().toFile(file);
}
const x0 = (inset) => inset;

await renderIcon({ inset: 100, shadow: true, file: p('build/icon.png') });
await renderIcon({ inset: 100, shadow: true, file: p('public/icon.png'), size: 512 });
await renderIcon({ inset: 0, shadow: false, file: p('public/brand.png'), size: 256 });

// Linux: o tema de ícones (hicolor) só procura tamanhos padrão; um único PNG de 1024 px não aparece
// no menu/dock do GNOME. Gera a pasta build/icons/NxN.png que o electron-builder instala.
import('node:fs').then(({ mkdirSync }) => mkdirSync(p('build/icons'), { recursive: true }));
await new Promise((r) => setTimeout(r, 50));
for (const n of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
  await sharp(p('build/icon.png')).resize(n, n, { kernel: 'lanczos3' }).png().toFile(p(`build/icons/${n}x${n}.png`));
}

// 3. Bandeja: colorido (Windows/Linux) e "template" preto (macOS se adapta a claro/escuro).
async function trayIcon(size, template) {
  const w = Math.round(size * (template ? 0.95 : 1));
  let v = sharp(mark).resize({ width: w, kernel: 'lanczos3' });
  if (template) v = v.linear([0, 0, 0, 1], [0, 0, 0, 0]);
  const buf = await v.png().toBuffer();
  const m = await sharp(buf).metadata();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: buf, left: Math.round((size - m.width) / 2), top: Math.round((size - m.height) / 2) }])
    .png();
}
await (await trayIcon(18, true)).toFile(p('public/tray/trayTemplate.png'));
await (await trayIcon(36, true)).toFile(p('public/tray/trayTemplate@2x.png'));
await (await trayIcon(16, false)).toFile(p('public/tray/tray.png'));
await (await trayIcon(32, false)).toFile(p('public/tray/tray@2x.png'));
await (await trayIcon(24, false)).toFile(p('public/tray/tray-linux.png'));

console.log(`V ${meta.width}x${meta.height} → ícones gerados`);
