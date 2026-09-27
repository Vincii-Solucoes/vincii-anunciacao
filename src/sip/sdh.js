// SessionDescriptionHandler do SIP.js para áudio RTP "puro" (sem WebRTC), compatível
// com qualquer PBX/operadora SIP. A mídia real fica no MediaEngine.
import { parseSdp, buildSdp, codecOf, answerDirection } from '../media/sdp.js';

export function makeSdhFactory(engine, getSettings) {
  return (session) => new RtpSdh(session, engine, getSettings);
}

class RtpSdh {
  constructor(session, engine, getSettings) {
    this.session = session;
    this.engine = engine;
    this.getSettings = getSettings;
    this.callId = session.data?.callId;
    this.rtp = null;
    this.remote = null; // último SDP remoto
    this.pendingOffer = null; // SDP remoto aguardando nossa resposta
    this.sessionId = Math.floor(Math.random() * 1e9);
    this.version = 0;
    this.localDirection = 'sendrecv';
    this.chosenPt = null;
    this.state = 'stable'; // stable | have-local-offer | have-remote-offer
  }

  get mediaAddress() {
    return this.session.userAgent.transport.mediaAddress;
  }

  _codecs() {
    const pref = this.getSettings().codecs || [8, 0];
    return pref.filter((pt) => pt === 0 || pt === 8);
  }

  async getDescription(options = {}) {
    const hold = !!options.hold;
    this.rtp = await this.engine.open(this.callId);
    let codecs = this._codecs();
    let dtmfPt = 101;
    let direction = hold ? 'sendonly' : 'sendrecv';

    if (this.state === 'have-remote-offer' && this.pendingOffer) {
      // Somos o lado que responde: escolhe o primeiro codec do ofertante que suportamos.
      const offer = this.pendingOffer;
      const pt = offer.fmts.find((f) => codecOf(offer, f) != null && codecs.includes(codecOf(offer, f)));
      if (pt == null) throw new Error('Nenhum codec compatível (use PCMA/PCMU)');
      this.chosenPt = pt;
      codecs = [pt];
      dtmfPt = offer.dtmfPt ?? 101;
      direction = answerDirection(offer.direction, hold);
      this.pendingOffer = null;
      this.state = 'stable';
      this.localDirection = direction;
      this._apply(offer);
    } else {
      this.state = 'have-local-offer';
      this.localDirection = direction;
    }
    const body = buildSdp({
      sessionId: this.sessionId,
      version: this.version++,
      address: this.mediaAddress,
      port: this.rtp.localPort,
      codecs,
      dtmfPt,
      direction,
    });
    return { body, contentType: 'application/sdp' };
  }

  async setDescription(sdp) {
    const desc = parseSdp(sdp);
    if (!desc.port && !desc.fmts.length) throw new Error('SDP sem áudio');
    this.rtp = await this.engine.open(this.callId);
    if (this.state === 'have-local-offer') {
      const pt = desc.fmts.find((f) => codecOf(desc, f) != null);
      if (pt == null) throw new Error('Resposta sem codec compatível');
      this.chosenPt = pt;
      this.state = 'stable';
      this._apply(desc);
    } else {
      this.pendingOffer = desc;
      this.state = 'have-remote-offer';
    }
  }

  _apply(desc) {
    this.remote = desc;
    const codec = codecOf(desc, this.chosenPt);
    const sendOk = ['sendrecv', 'sendonly'].includes(this.localDirection) && ['sendrecv', 'recvonly'].includes(desc.direction);
    this.rtp.configure({
      address: desc.address,
      port: desc.port,
      pt: codec,
      dtmfPt: desc.dtmfPt ?? 101,
      send: sendOk && desc.port > 0,
    });
    this.session.data.onMedia?.({
      remoteHold: desc.direction === 'sendonly' || desc.direction === 'inactive' || desc.port === 0,
      codec: codec === 0 ? 'PCMU' : 'PCMA',
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
