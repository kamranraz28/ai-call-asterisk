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

/* ---- band-limited windowed-sinc resampler (high quality) ---- */

function kaiser(beta, n, len) {
  // approximate I0(x); x bounded for stability
  const x = beta * Math.sqrt(1 - Math.pow((2 * n / (len - 1)) - 1, 2));
  return i0(x) / i0(beta);
}
function i0(x) {
  let sum = 1.0, term = 1.0, n = 1;
  const threshold = 1e-18;
  const xx = x * x / 4;
  do {
    term *= xx / (n * n);
    sum += term;
    n++;
  } while (term > threshold);
  return sum;
}

let sincCache = new Map();

// Build a windowed-sinc low-pass filter kernel with cutoff as fraction of input Nyquist.
// Handles any ratio; anti-aliases by using cutoff <= output Nyquist when downsampling.
function buildKernel(cutoff, taps) {
  const key = `${cutoff.toFixed(5)}_${taps}`;
  if (sincCache.has(key)) return sincCache.get(key);
  const M = taps - 1;
  const mid = M / 2;
  const h = new Float32Array(taps);
  let sumNorm = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    let sincVal;
    if (x === 0) sincVal = 2 * cutoff;
    else sincVal = Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    h[i] = sincVal * kaiser(8.0, x + mid, taps);
    sumNorm += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= (sumNorm || 1);
  sincCache.set(key, h);
  return h;
}

// resample pcm16 (LE) between two rates with band-limited quality
// ratio = fromRate / toRate (input samples consumed per output sample)
function resampleSinc(pcm16Buf, fromRate, toRate, taps = 32) {
  const inSamples = pcm16Buf.length / 2;
  if (inSamples === 0) return Buffer.alloc(0);
  const ratio = fromRate / toRate;

  // anti-alias cutoff: keep maximum frequency supported by both rates with margin
  const maxOut = 0.9 * (toRate / 2);
  const maxIn = 0.9 * (fromRate / 2);
  const cutoffHz = Math.min(maxIn, maxOut);
  const cutoff = cutoffHz / fromRate; // fraction of input sample rate

  const kernel = buildKernel(cutoff, taps);
  const mid = Math.floor(taps / 2);

  const outSamples = Math.floor(inSamples / ratio);
  if (outSamples <= 0) return Buffer.alloc(2);
  const out = Buffer.alloc(outSamples * 2);

  // read input as Float32 for precision
  const src = new Float32Array(inSamples);
  for (let i = 0; i < inSamples; i++) src[i] = pcm16Buf.readInt16LE(i * 2);

  for (let o = 0; o < outSamples; o++) {
    const center = o * ratio; // fractional input position
    const start = Math.floor(center) - mid;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const srcIdx = start + k;
      if (srcIdx < 0 || srcIdx >= inSamples) continue;
      const rel = (srcIdx - center); // in input-sample units
      // evaluate kernel at rel (kernel is symmetric, taps spaced 1 sample)
      // use integer tap index based on (center - srcIdx) mapped to nearest
      // simpler: resample kernel by index k offset with fractional part
      const frac = center - srcIdx;
      const tapPos = frac + mid;
      const k0 = Math.floor(tapPos);
      const f = tapPos - k0;
      const v0 = k0 >= 0 && k0 < taps ? kernel[k0] : 0;
      const v1 = (k0 + 1) >= 0 && (k0 + 1) < taps ? kernel[k0 + 1] : 0;
      const hv = v0 * (1 - f) + v1 * f;
      acc += src[srcIdx] * hv;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), o * 2);
  }
  return out;
}

// soft-knee limiter + gentle normalization: prevents clipping distortion and keeps
// consistent level. targetPeak <= 1.0 fraction of full scale.
export function normalizeSoft(pcm16Buf, targetPeak = 0.6) {
  const n = pcm16Buf.length / 2;
  if (n === 0) return pcm16Buf;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(pcm16Buf.readInt16LE(i * 2));
    if (a > peak) peak = a;
  }
  if (peak === 0) return pcm16Buf;
  // add small floor to avoid wildly boosting silence
  const gain = Math.min(targetPeak * 32767 / Math.max(peak, 1), 4.0);
  const out = Buffer.alloc(pcm16Buf.length);
  for (let i = 0; i < n; i++) {
    let s = pcm16Buf.readInt16LE(i * 2) * gain;
    // soft clip: knee below full scale so int16 can never wrap
    const x = s / 32767;
    let y;
    const a = 0.98, k = 1.4;
    if (Math.abs(x) < a) y = x;
    else y = (a + ((Math.abs(x) - a) / ((Math.abs(x) - a) * k + 1))) * (x < 0 ? -1 : 1);
    if (y > 1) y = 1; else if (y < -1) y = -1;
    out.writeInt16LE(Math.round(y * 32767), i * 2);
  }
  return out;
}

export function resampleLinear(pcm16Buf, fromRate, toRate) {
  if (fromRate === toRate) return pcm16Buf;
  return resampleSinc(pcm16Buf, fromRate, toRate);
}

// Stateful streaming resampler: keeps the fractional phase + sliding input
// history across chunks so the 24k->8k stream is phase-continuous. This removes
// the per-chunk boundary pops that independent one-shot resamples produce.
export function createStreamResampler(fromRate, toRate, taps = 33) {
  if (taps % 2 === 0) taps += 1; // odd so mid is integer
  const ratio = fromRate / toRate;
  const maxOut = 0.9 * (toRate / 2);
  const maxIn = 0.9 * (fromRate / 2);
  const cutoffHz = Math.min(maxIn, maxOut);
  const cutoff = cutoffHz / fromRate;
  const kernel = buildKernel(cutoff, taps);
  const mid = (taps - 1) / 2;

  let hist = new Float32Array(0);
  let pos = 0;   // absolute input-sample position (fractional) of next output center
  let base = 0;  // absolute input index of hist[0]

  function step(pcm16Buf) {
    const n = pcm16Buf.length / 2;
    if (n === 0) return Buffer.alloc(0);
    const newHist = new Float32Array(hist.length + n);
    newHist.set(hist, 0);
    for (let i = 0; i < n; i++) newHist[hist.length + i] = pcm16Buf.readInt16LE(i * 2);
    hist = newHist;

    const out = [];
    while (pos + mid + 1 <= base + hist.length) {
      const center = pos;
      const startIdx = Math.floor(center) - mid;
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = startIdx + k;
        const absIdx = idx - base;
        if (absIdx < 0 || absIdx >= hist.length) continue;
        const offset = center - idx;
        const kpos = offset + mid;
        const k0 = Math.floor(kpos);
        const f = kpos - k0;
        const h0 = k0 >= 0 && k0 < taps ? kernel[k0] : 0;
        const h1 = k0 + 1 < taps ? kernel[k0 + 1] : 0;
        acc += hist[absIdx] * (h0 * (1 - f) + h1 * f);
      }
      out.push(acc);
      pos += ratio;
    }
    const keepFromAbs = Math.floor(pos - mid);
    const trimStart = Math.max(0, keepFromAbs - base);
    if (trimStart > 0) {
      hist = hist.slice(trimStart);
      base += trimStart;
    }
    const res = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      res.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), i * 2);
    }
    return res;
  }
  return step;
}

// Clear DC drift and low rumble that g.711 is sensitive to
export function dcBlocker(pcm16Buf) {
  const n = pcm16Buf.length / 2;
  const out = Buffer.from(pcm16Buf);
  let prev = 0;
  const alpha = 0.99;
  for (let i = 0; i < n; i++) {
    const x = out.readInt16LE(i * 2);
    let y = x - prev + alpha * prev;
    if (y > 0x7fff) y = 0x7fff; else if (y < -0x8000) y = -0x8000;
    out.writeInt16LE(Math.round(y), i * 2);
    prev = y;
  }
  return out;
}

// Streaming DC blocker: carries filter state across chunks so we don't get
// a restart click at every chunk boundary (the old dcBlocker reset prev=0).
export function createStreamDcBlocker(alpha = 0.99) {
  let prev = 0;
  return function step(pcm16Buf) {
    const n = pcm16Buf.length / 2;
    const out = Buffer.from(pcm16Buf);
    for (let i = 0; i < n; i++) {
      const x = out.readInt16LE(i * 2);
      let y = x - prev + alpha * prev;
      if (y > 0x7fff) y = 0x7fff; else if (y < -0x8000) y = -0x8000;
      out.writeInt16LE(Math.round(y), i * 2);
      prev = y;
    }
    return out;
  };
}

// Fixed soft-limiter: transparent below threshold, never wraps past 32767.
// Unlike normalizeSoft it doesn't adapt gain per chunk (no pumping) and its
// knee sits below full scale so int16 can't overflow (old code allowed it).
export function softLimit(pcm16Buf, threshold = 0.98) {
  const n = pcm16Buf.length / 2;
  const out = Buffer.alloc(pcm16Buf.length);
  const a = threshold, k = 8;
  for (let i = 0; i < n; i++) {
    let x = pcm16Buf.readInt16LE(i * 2) / 32767;
    let y;
    const ax = Math.abs(x);
    if (ax < a) y = x;
    else y = (a + (ax - a) / ((ax - a) * k + 1)) * (x < 0 ? -1 : 1);
    if (y > 1) y = 1; else if (y < -1) y = -1;
    out.writeInt16LE(Math.round(y * 32767), i * 2);
  }
  return out;
}
