import dgram from 'dgram';

export function createRtpSocket(port, onPayload) {
  const sock = dgram.createSocket('udp4');
  let remote = null;
  let actualPort = port;

  let pending = [];
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    if (!remote) {
      remote = { address: rinfo.address, port: rinfo.port };
      for(const p of pending) sock.send(p, remote.port, remote.address);
      pending = [];
    } else {
      remote = { address: rinfo.address, port: rinfo.port };
    }
    const payload = msg.subarray(12);
    onPayload(payload, remote);
  });

  sock.bind(port);
  sock.on('listening', () => { actualPort = sock.address().port; });

  let seq = Math.floor(Math.random() * 0xffff);
  let ts = Math.floor(Math.random() * 0xffffffff);
  const ssrc = Math.floor(Math.random() * 0xffffffff);

  function sendUlaw(ulawBuf) { send(ulawBuf, 160); }
  function sendSlin16(pcmBuf) { send(pcmBuf, 320); }
  function send(buf, samples) {
    const pkt = Buffer.alloc(12 + buf.length);
    pkt[0] = 0x80;
    pkt[1] = 0x00;
    pkt.writeUInt16BE(seq & 0xffff, 2);
    pkt.writeUInt32BE(ts >>> 0, 4);
    pkt.writeUInt32BE(ssrc >>> 0, 8);
    buf.copy(pkt, 12);
    if (!remote) { pending.push(pkt); return; }
    sock.send(pkt, remote.port, remote.address);
    seq = (seq + 1) & 0xffff;
    ts = (ts + samples) >>> 0;
  }

  function setRemote(address, port) { 
    const wasNull = !remote;
    remote = { address, port }; 
    if (wasNull && pending.length) {
      for(const p of pending) sock.send(p, remote.port, remote.address);
      pending = [];
    }
  }
  function getPort() { try{ return sock.address().port; } catch{ return actualPort; } }

  return { sock, sendUlaw, sendSlin16, setRemote, getRemote: () => remote, getPort };
}
