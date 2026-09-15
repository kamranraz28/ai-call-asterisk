const BIAS = 0x84;
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_MASK = 0x70;

export function ulawToPcm16(ulaw) {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & SIGN_BIT;
  const seg = (ulaw & SEG_MASK) >> 4;
  const quant = ulaw & QUANT_MASK;
  let t = (quant << 3) + BIAS;
  t <<= seg;
  return sign ? BIAS - t : t - BIAS;
}

export function pcm16ToUlaw(pcm) {
  let sign = 0;
  if (pcm < 0) { sign = 0x80; pcm = -pcm; }
  if (pcm > 32635) pcm = 32635;
  pcm += BIAS;
  let seg = 7;
  for (let i = 0; i < 8; i++) {
    if (pcm <= (0x1f << (i + 3))) { seg = i; break; }
  }
  const quant = (pcm >> (seg + 3)) & 0x0f;
  return ~(sign | (seg << 4) | quant) & 0xff;
}

export function ulawBufferToPcm16Buffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    out.writeInt16LE(ulawToPcm16(ulawBuf[i]), i * 2);
  }
  return out;
}

export function pcm16BufferToUlawBuffer(pcmBuf) {
  const n = pcmBuf.length / 2;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = pcm16ToUlaw(pcmBuf.readInt16LE(i * 2));
  return out;
}

export function resampleLinear(pcm16Buf, fromRate, toRate) {
  if (fromRate === toRate) return pcm16Buf;
  const inSamples = pcm16Buf.length / 2;
  const outSamples = Math.round(inSamples * toRate / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = i * fromRate / toRate;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = idx < inSamples ? pcm16Buf.readInt16LE(idx * 2) : 0;
    const s1 = idx + 1 < inSamples ? pcm16Buf.readInt16LE((idx + 1) * 2) : s0;
    const s = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}
