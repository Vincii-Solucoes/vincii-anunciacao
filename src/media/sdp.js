// SDP para áudio RTP/AVP: Opus, G.722, G.711 e telephone-event (DTMF).
import { CODECS, codecIdFromRtpmap, staticCodec } from './codecs.js';

export const DIRS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

export function parseSdp(text) {
  const out = { address: null, port: 0, fmts: [], rtpmap: {}, fmtp: {}, direction: 'sendrecv', ptime: 20, dtmf: [] };
  let inAudio = false;
  let sessionAddr = null;
  let mediaAddr = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const [media, port, , ...fmts] = line.slice(2).split(/\s+/);
      inAudio = media === 'audio' && !out.port;
      if (inAudio) {
        out.port = Number(port);
        out.fmts = fmts.map(Number);
      }
    } else if (line.startsWith('c=')) {
      const addr = line.split(/\s+/)[2];
      if (inAudio) mediaAddr = addr;
      else if (!out.port) sessionAddr = addr;
    } else if (line.startsWith('a=')) {
      const attr = line.slice(2);
      if (!inAudio && out.port) continue;
      if (DIRS.includes(attr)) out.direction = attr;
      else if (attr.startsWith('rtpmap:')) {
        const [pt, enc] = attr.slice(7).split(/\s+/);
        out.rtpmap[Number(pt)] = enc;
        const m = enc.match(/^telephone-event\/(\d+)/i);
        if (m) out.dtmf.push({ pt: Number(pt), clock: Number(m[1]) });
      } else if (attr.startsWith('fmtp:')) {
        const [pt, ...rest] = attr.slice(5).split(/\s+/);
        out.fmtp[Number(pt)] = rest.join(' ');
      } else if (attr.startsWith('ptime:')) out.ptime = Number(attr.slice(6)) || 20;
    }
  }
  out.address = mediaAddr || sessionAddr;
  if (out.address === '0.0.0.0') out.direction = out.direction === 'sendrecv' ? 'sendonly' : out.direction;
  return out;
}

// Codec (id) de um payload type do SDP; payload types estáticos podem vir sem rtpmap.
export const codecOf = (sdp, pt) => (sdp.rtpmap[pt] ? codecIdFromRtpmap(sdp.rtpmap[pt]) : staticCodec(pt));

// Mapa payload type -> codec de uma descrição.
export function ptMap(sdp) {
  const m = {};
  for (const pt of sdp.fmts) {
    const id = codecOf(sdp, pt);
    if (id) m[pt] = id;
  }
  return m;
}

// codecs: [{ id, pt }] na ordem de preferência; dtmf: [{ pt, clock }]
export function buildSdp({ sessionId, version, address, port, codecs, dtmf, direction = 'sendrecv' }) {
  const fmts = [...codecs.map((c) => c.pt), ...dtmf.map((d) => d.pt)];
  const lines = [
    'v=0',
    `o=vincii ${sessionId} ${version} IN IP4 ${address}`,
    's=Anunciacao',
    `c=IN IP4 ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${fmts.join(' ')}`,
  ];
  for (const c of codecs) {
    lines.push(`a=rtpmap:${c.pt} ${CODECS[c.id].rtpmap}`);
    if (CODECS[c.id].fmtp) lines.push(`a=fmtp:${c.pt} ${CODECS[c.id].fmtp}`);
  }
  for (const d of dtmf) {
    lines.push(`a=rtpmap:${d.pt} telephone-event/${d.clock}`);
    lines.push(`a=fmtp:${d.pt} 0-16`);
  }
  lines.push('a=ptime:20', `a=${direction}`);
  return lines.join('\r\n') + '\r\n';
}

// Nossa oferta: codecs da linha na ordem escolhida + DTMF nos relógios necessários.
export function offerCodecs(ids) {
  const codecs = ids.map((id) => ({ id, pt: CODECS[id].pt }));
  const dtmf = [{ pt: 101, clock: 8000 }];
  if (ids.includes('opus')) dtmf.push({ pt: 100, clock: 48000 });
  return { codecs, dtmf };
}

export const answerDirection = (offered, wantHold) => {
  const map = { sendrecv: 'sendrecv', sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' };
  let d = map[offered] || 'sendrecv';
  if (wantHold) d = d === 'sendrecv' ? 'sendonly' : d === 'recvonly' ? 'inactive' : d;
  return d;
};
