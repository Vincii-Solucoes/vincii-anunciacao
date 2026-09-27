// SDP mínimo para áudio RTP/AVP (G.711 + telephone-event).
export const DIRS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];
const NAMES = { 0: 'PCMU', 8: 'PCMA' };

export function parseSdp(text) {
  const out = { address: null, port: 0, fmts: [], rtpmap: {}, direction: 'sendrecv', ptime: 20, dtmfPt: null };
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
        if (/^telephone-event\/8000/i.test(enc)) out.dtmfPt = Number(pt);
      } else if (attr.startsWith('ptime:')) out.ptime = Number(attr.slice(6)) || 20;
    }
  }
  out.address = mediaAddr || sessionAddr;
  if (out.address === '0.0.0.0') out.direction = out.direction === 'sendrecv' ? 'sendonly' : out.direction;
  return out;
}

// Payload types estáticos 0/8 podem vir sem rtpmap.
export const codecOf = (sdp, pt) => {
  const enc = sdp.rtpmap[pt];
  if (enc) return /^PCMU\/8000/i.test(enc) ? 0 : /^PCMA\/8000/i.test(enc) ? 8 : null;
  return pt === 0 || pt === 8 ? pt : null;
};

export function buildSdp({ sessionId, version, address, port, codecs, dtmfPt = 101, direction = 'sendrecv' }) {
  const fmts = [...codecs, dtmfPt];
  const lines = [
    'v=0',
    `o=vincii ${sessionId} ${version} IN IP4 ${address}`,
    's=Anunciacao',
    `c=IN IP4 ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${fmts.join(' ')}`,
    ...codecs.map((pt) => `a=rtpmap:${pt} ${NAMES[pt]}/8000`),
    `a=rtpmap:${dtmfPt} telephone-event/8000`,
    `a=fmtp:${dtmfPt} 0-16`,
    'a=ptime:20',
    `a=${direction}`,
  ];
  return lines.join('\r\n') + '\r\n';
}

export const answerDirection = (offered, wantHold) => {
  const map = { sendrecv: 'sendrecv', sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' };
  let d = map[offered] || 'sendrecv';
  if (wantHold) d = d === 'sendrecv' ? 'sendonly' : d === 'recvonly' ? 'inactive' : d;
  return d;
};
