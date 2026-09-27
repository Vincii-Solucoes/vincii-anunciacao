// Motor de mídia: um AudioContext compartilhado por todas as chamadas.
import workletUrl from './engine-worklet.js?url';
import { RtpStream } from './rtp.js';


export class MediaEngine {
  constructor(bridge, settings) {
    this.bridge = bridge; // window.vincii.net
    this.settings = settings;
    this.ctx = null;
    this.node = null;
    this.mic = null;
    this.micSource = null;
    this.streams = new Map(); // callId -> RtpStream
    this.bySocket = new Map(); // socketId -> RtpStream
    this.ready = null;
    this.onLevel = null;
    this.sinkEl = null;
    bridge.onMessage((id, data, rinfo) => this.bySocket.get(id)?.receive(data, rinfo));
  }

  async _init() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(this.ctx, 'vincii-engine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e) => this._onWorklet(e.data);
    await this._routeOutput();
  }

  // A saída passa por um par WebRTC local para que o cancelamento de eco do Chromium
  // tenha a referência do que sai no alto-falante. Se falhar, toca direto.
  async _routeOutput() {
    const speaker = this.settings.speakerId || '';
    if (this.settings.echoCancellation !== false) {
      try {
        const dest = this.ctx.createMediaStreamDestination();
        this.node.connect(dest);
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
        const got = new Promise((res) => (b.ontrack = (e) => res(e.streams[0] || new MediaStream([e.track]))));
        dest.stream.getTracks().forEach((t) => a.addTrack(t, dest.stream));
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        // Opus em alta taxa e sem DTX para não degradar o áudio local.
        answer.sdp = answer.sdp.replace(/(a=fmtp:\d+ .*)/, '$1;maxaveragebitrate=128000;usedtx=0');
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        const stream = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
        const el = new Audio();
        el.srcObject = stream;
        if (speaker && el.setSinkId) await el.setSinkId(speaker).catch(() => {});
        await el.play();
        this.sinkEl = el;
        this._loop = [a, b];
        return;
      } catch (err) {
        console.warn('Saída com AEC indisponível, usando saída direta', err);
        this.node.disconnect();
      }
    }
    this.node.connect(this.ctx.destination);
    if (speaker && this.ctx.setSinkId) await this.ctx.setSinkId(speaker).catch(() => {});
  }

  ensure() {
    if (!this.ready) this.ready = this._init().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async setSpeaker(id) {
    this.settings.speakerId = id;
    if (!this.ctx) return;
    if (this.sinkEl?.setSinkId) await this.sinkEl.setSinkId(id || '').catch(() => {});
    else if (this.ctx.setSinkId) await this.ctx.setSinkId(id || '').catch(() => {});
  }

  async _startMic() {
    if (this.mic) return;
    const s = this.settings;
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.micId ? { ideal: s.micId } : undefined,
        echoCancellation: s.echoCancellation !== false,
        noiseSuppression: s.noiseSuppression !== false,
        autoGainControl: s.autoGainControl !== false,
        channelCount: 1,
      },
    });
    this.micSource = this.ctx.createMediaStreamSource(this.mic);
    this.micSource.connect(this.node);
  }

  _stopMic() {
    this.micSource?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micSource = null;
  }

  async restartMic() {
    if (!this.mic) return;
    this._stopMic();
    await this._startMic();
  }

  _onWorklet(m) {
    if (m.type === 'level') {
      this.onLevel?.(m.mic);
      return;
    }
    for (const { id, pcm } of m.tx) this.streams.get(id)?.sendAudio(pcm);
  }

  // Abre a porta RTP local de uma chamada.
  async open(callId) {
    await this.ensure();
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    const existing = this.streams.get(callId);
    if (existing) return existing;
    const s = this.settings;
    const { id, port } = await this.bridge.udpOpen({ range: [s.rtpMin || 10000, s.rtpMax || 20000] });
    const rtp = new RtpStream(this.bridge, id, port);
    rtp.onAudio = (pcm) => this.node.port.postMessage({ type: 'rx', id: callId, pcm }, [pcm.buffer]);
    this.streams.set(callId, rtp);
    this.bySocket.set(id, rtp);
    this.node.port.postMessage({ type: 'add', id: callId });
    await this._startMic().catch((err) => console.warn('Microfone indisponível', err));
    return rtp;
  }

  setState(callId, state) {
    this.node?.port.postMessage({ type: 'state', id: callId, state });
  }

  close(callId) {
    const rtp = this.streams.get(callId);
    if (rtp) {
      this.bridge.close(rtp.socketId);
      this.bySocket.delete(rtp.socketId);
      this.streams.delete(callId);
    }
    this.node?.port.postMessage({ type: 'remove', id: callId });
    if (!this.streams.size) this._stopMic();
  }

}
