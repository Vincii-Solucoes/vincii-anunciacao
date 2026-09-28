// Log de diagnóstico (arquivo no app desktop; console no navegador).
const mask = (s) => String(s).replace(/^((?:Proxy-)?Authorization\s*:\s*Digest\s+).*$/gim, '$1[oculto]');
let buf = '';
let timer = null;

export function log(tag, text) {
  const line = `[${new Date().toISOString()}] ${tag}${text ? `\n${mask(text).trimEnd()}` : ''}\n\n`;
  if (!window.vincii?.log) return;
  buf += line;
  if (!timer) timer = setTimeout(flush, 300);
}

export function flush() {
  timer = null;
  if (buf) window.vincii.log.write(buf);
  buf = '';
}
