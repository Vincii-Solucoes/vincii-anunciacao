// Sockets de rede (SIP e RTP) no processo principal. O renderer não tem acesso ao Node;
// ele usa esta ponte via IPC.
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

const sockets = new Map(); // id -> { kind, sock }
let seq = 0;
let sendToRenderer = () => {};

export function setNetSink(fn) {
  sendToRenderer = fn;
}

export function closeAll() {
  for (const id of [...sockets.keys()]) closeSocket(id);
}

function register(kind, sock) {
  const id = ++seq;
  sockets.set(id, { kind, sock });
  return id;
}

export function closeSocket(id) {
  const s = sockets.get(id);
  if (!s) return;
  sockets.delete(id);
  try {
    if (s.kind === 'udp') s.sock.close();
    else s.sock.destroy();
  } catch {
    /* já fechado */
  }
}

function bindUdp(port, host) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    const onErr = (err) => {
      sock.close();
      reject(err);
    };
    sock.once('error', onErr);
    sock.bind(port, host, () => {
      sock.off('error', onErr);
      resolve(sock);
    });
  });
}

// Abre um socket UDP. Com `range`, procura uma porta par livre (RTP) dentro da faixa.
export async function udpOpen({ port = 0, range } = {}) {
  let sock;
  if (range) {
    const [min, max] = range;
    const span = Math.max(1, Math.floor((max - min) / 2));
    const start = Math.floor(Math.random() * span);
    for (let i = 0; i < span && !sock; i++) {
      const p = min + ((start + i) % span) * 2;
      sock = await bindUdp(p, '0.0.0.0').catch(() => null);
    }
    if (!sock) throw new Error('Nenhuma porta RTP livre na faixa configurada');
  } else {
    sock = await bindUdp(port, '0.0.0.0');
  }
  const id = register('udp', sock);
  sock.on('message', (msg, rinfo) => sendToRenderer('net:message', id, msg, { address: rinfo.address, port: rinfo.port }));
  sock.on('error', (err) => sendToRenderer('net:error', id, err.message));
  return { id, port: sock.address().port };
}

export function udpSend(id, data, port, host) {
  const s = sockets.get(id);
  if (!s || s.kind !== 'udp') return;
  s.sock.send(Buffer.from(data), port, host, () => {});
}

// SIP sobre TCP/TLS: separa as mensagens do fluxo pelo Content-Length.
export function streamConnect({ host, port, secure, servername, verify = true }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port };
    const sock = secure
      ? tls.connect({ ...opts, servername: servername || undefined, rejectUnauthorized: verify })
      : net.connect(opts);
    sock.setKeepAlive(true, 15000);
    sock.setNoDelay(true);
    const onErr = (err) => {
      sock.destroy();
      reject(err);
    };
    sock.once('error', onErr);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.off('error', onErr);
      const id = register('stream', sock);
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // Segurança: mensagens SIP legítimas são pequenas; fluxo malformado derruba a conexão.
        if (buf.length > 256 * 1024) {
          sock.destroy(new Error('Mensagem SIP grande demais'));
          return;
        }
        for (;;) {
          while (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) buf = buf.subarray(2); // keep-alive CRLF
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) break;
          const head = buf.subarray(0, end).toString('utf8');
          const m = head.match(/^(?:content-length|l)\s*:\s*(\d+)/im);
          const len = m ? Number(m[1]) : 0;
          if (len > 128 * 1024) {
            sock.destroy(new Error('Content-Length inválido'));
            return;
          }
          const total = end + 4 + len;
          if (buf.length < total) break;
          sendToRenderer('net:message', id, buf.subarray(0, total), { address: host, port });
          buf = buf.subarray(total);
        }
      });
      sock.on('error', (err) => sendToRenderer('net:error', id, err.message));
      sock.on('close', () => {
        if (sockets.has(id)) {
          sockets.delete(id);
          sendToRenderer('net:close', id);
        }
      });
      resolve({ id, localAddress: sock.localAddress?.replace(/^::ffff:/, ''), localPort: sock.localPort });
    });
  });
}

export function streamSend(id, text) {
  const s = sockets.get(id);
  if (!s || s.kind !== 'stream') return;
  s.sock.write(text);
}

const isIp = (h) => net.isIP(h) !== 0;

// Resolve o servidor SIP: SRV (_sip._udp / _sip._tcp / _sips._tcp) quando não há porta, depois A.
export async function resolveServer({ host, port, transport }) {
  let target = host;
  let targetPort = port;
  if (!isIp(host) && !port) {
    const prefix = transport === 'TLS' ? '_sips._tcp' : transport === 'TCP' ? '_sip._tcp' : '_sip._udp';
    try {
      const srv = await dns.resolveSrv(`${prefix}.${host}`);
      srv.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      if (srv[0]) {
        target = srv[0].name;
        targetPort = srv[0].port;
      }
    } catch {
      /* sem SRV */
    }
  }
  const address = isIp(target) ? target : (await dns.lookup(target, { family: 4 })).address;
  return { address, port: targetPort || (transport === 'TLS' ? 5061 : 5060) };
}

// Descobre qual IP local é usado para alcançar o servidor.
export function localAddressFor({ address, port }) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(port, address, (err) => {
      const ip = err ? '127.0.0.1' : s.address().address;
      s.close();
      resolve(ip);
    });
  });
}
