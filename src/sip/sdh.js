// SessionDescriptionHandler do SIP.js para áudio RTP "puro" (sem WebRTC), compatível
// com qualquer PBX/operadora SIP. Os codecs vêm da configuração de cada linha.
import { parseSdp, buildSdp, codecOf, ptMap, offerCodecs, answerDirection } from '../media/sdp.js';
import { CODECS, opusSupported, g729Available } from '../media/codecs.js';

export function makeSdhFactory(engine) {
  return (session) => new RtpSdh(session, engine);
}

class RtpSdh {
  constructor(session, engine) {
    this.session = session;
    this.engine = engine;
    this.callId = session.data?.callId;
    this.rtp = null;
    this.pendingOffer = null;
    this.localOffer = null; // o que ofertamos (para interpretar a resposta)
    this.sessionId = Math.floor(Math.random() * 1e9);
    this.version = 0;
    this.localDirection = 'sendrecv';
    this.state = 'stable'; // stable | have-local-offer | have-remote-offer
  }

  get mediaAddress() {
    return this.session.userAgent.transport.mediaAddress;
  }

  // Codecs habilitados na linha, na ordem de preferência.
  _allowed() {
    const ids = (this.session.data?.codecs || ['PCMA', 'PCMU']).filter((id) => CODECS[id]);
    return ids.filter((id) => (id !== 'opus' || opusSupported()) && (id !== 'G729' || g729Available()));
  }

  async getDescription(options = {}) {
    const hold = !!options.hold;
    this.rtp = await this.engine.open(this.callId);
    let codecs;
    let dtmf;
    let direction = hold ? 'sendonly' : 'sendrecv';

    if (this.state === 'have-remote-offer' && this.pendingOffer) {
      // Respondendo: primeiro codec da oferta (ordem do ofertante) que esta linha aceita.
      const offer = this.pendingOffer;
      const allowed = this._allowed();
      const pt = offer.fmts.find((f) => allowed.includes(codecOf(offer, f)));
      if (pt == null) throw new Error('Nenhum codec em comum com o outro lado');
      const id = codecOf(offer, pt);
      codecs = [{ id, pt }];
      const clock = CODECS[id].clock === 48000 ? 48000 : 8000;
      dtmf = offer.dtmf.filter((d) => d.clock === clock).slice(0, 1);
      direction = answerDirection(offer.direction, hold);
      this.pendingOffer = null;
      this.state = 'stable';
      this.localDirection = direction;
      this._apply(offer, { id, pt, rxMap: { [pt]: id } });
    } else {
      ({ codecs, dtmf } = offerCodecs(this._allowed()));
      if (!codecs.length) throw new Error('Nenhum codec habilitado nesta linha');
      this.localOffer = { codecs, dtmf };
      this.state = 'have-local-offer';
      this.localDirection = direction;
    }
    const body = buildSdp({
      sessionId: this.sessionId,
      version: this.version++,
      address: this.mediaAddress,
      port: this.rtp.localPort,
      codecs,
      dtmf,
      direction,
    });
    return { body, contentType: 'application/sdp' };
  }

  async setDescription(sdp) {
    const desc = parseSdp(sdp);
    if (!desc.port && !desc.fmts.length) throw new Error('SDP sem áudio');
    this.rtp = await this.engine.open(this.callId);
    if (this.state === 'have-local-offer') {
      const allowed = this._allowed();
      const pt = desc.fmts.find((f) => allowed.includes(codecOf(desc, f)));
      if (pt == null) throw new Error('Resposta sem codec compatível');
      // Recebemos com os payload types que nós ofertamos; enviamos com os da resposta.
      const rxMap = {};
      for (const c of this.localOffer?.codecs || []) rxMap[c.pt] = c.id;
      this.state = 'stable';
      this._apply(desc, { id: codecOf(desc, pt), pt, rxMap: { ...rxMap, ...ptMap(desc) } });
    } else {
      this.pendingOffer = desc;
      this.state = 'have-remote-offer';
    }
  }

  _apply(desc, { id, pt, rxMap }) {
    const clock = CODECS[id].clock === 48000 ? 48000 : 8000;
    const dtmf = desc.dtmf.find((d) => d.clock === clock) || { pt: 101, clock };
    const sendOk = ['sendrecv', 'sendonly'].includes(this.localDirection) && ['sendrecv', 'recvonly'].includes(desc.direction);
    this.rtp.configure({
      address: desc.address,
      port: desc.port,
      codec: id,
      pt,
      rxMap,
      dtmf,
      send: sendOk && desc.port > 0,
      server: this.session.userAgent.transport.server?.address,
    });
    this.session.data.onMedia?.({
      remoteHold: desc.direction === 'sendonly' || desc.direction === 'inactive' || desc.port === 0,
      codec: CODECS[id].short,
    });
  }

  hasDescription(contentType) {
    return /application\/sdp/i.test(contentType || '');
  }

  async rollbackDescription() {
    this.pendingOffer = null;
    this.state = 'stable';
  }

  sendDtmf(tones) {
    if (!this.rtp) return false;
    for (const t of String(tones)) this.rtp.sendDtmf(t);
    return true;
  }

  close() {
    this.engine.close(this.callId);
    this.rtp = null;
  }
}
