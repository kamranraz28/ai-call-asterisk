import { GoogleGenAI } from '@google/genai';
import { log, logError } from './logger.js';
import { ulawBufferToPcm16Buffer, pcm16BufferToUlawBuffer, resampleLinear } from './codecs.js';

export class GeminiLiveSession {
  constructor({ callId, apiKey, model, onAudioOut, onInterrupted, onClose }) {
    this.callId = callId;
    this.model = model;
    this.apiKey = apiKey;
    this.onAudioOut = onAudioOut;
    this.onInterrupted = onInterrupted;
    this.onClose = onClose;
    this.session = null;
    this.connectedAt = 0;
    this.firstAudioAt = 0;
    this.opened = false;
    this.closed = false;
  }

  async connect() {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const cfg = {
      model: this.model,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        systemInstruction: 'You are a helpful phone assistant. Keep answers concise for phone call.',
      },
    };

    this.session = await ai.live.connect({
      ...cfg,
      callbacks: {
        onopen: () => {
          this.connectedAt = Date.now();
          this.opened = true;
          log('GEMINI_CONNECTED', { call_id: this.callId, ms: this.connectedAt });
        },
        onmessage: (msg) => this.handleMessage(msg),
        onerror: (e) => logError('GEMINI_ERROR', e, { call_id: this.callId }),
        onclose: (e) => { log('GEMINI_CLOSED', { call_id: this.callId, reason: e?.reason || '' }); this.closed = true; this.onClose?.(e); },
      },
    });
    log('GEMINI_CONNECTED', { call_id: this.callId });
  }

  handleMessage(msg) {
    try {
      const parts = msg?.serverContent?.modelTurn?.parts || msg?.serverContent?.parts || [];
      for (const p of parts) {
        const b64 = p?.inlineData?.data;
        const mime = p?.inlineData?.mimeType || '';
        if (b64 && mime.includes('audio')) {
          const pcm24k = Buffer.from(b64, 'base64');
          if (!this.firstAudioAt) {
            this.firstAudioAt = Date.now();
            log('GEMINI_AUDIO', { call_id: this.callId, first_audio_ms: this.firstAudioAt, latency_since_connect: this.firstAudioAt - this.connectedAt });
          } else {
            log('GEMINI_AUDIO', { call_id: this.callId, bytes: pcm24k.length });
          }
          const pcm8k = resampleLinear(pcm24k, 24000, 8000);
          const ulaw = Buffer.concat([pcm16BufferToUlawBuffer(pcm8k)]);
          this.chunkQueue(ulaw);
        }
      }
      if (msg?.serverContent?.interrupted) {
        log('AI_INTERRUPTED', { call_id: this.callId });
        this.onInterrupted?.();
      }
      if (msg?.serverContent?.turnComplete) {
        log('AI_TURN_COMPLETE', { call_id: this.callId });
      }
    } catch (e) {
      logError('GEMINI_MSG_ERROR', e, { call_id: this.callId });
    }
  }

  chunkQueue(ulaw) {
    const chunkSize = 160;
    for (let i = 0; i < ulaw.length; i += chunkSize) {
      const c = ulaw.subarray(i, i + chunkSize);
      this.onAudioOut(c);
    }
  }

  sendUlaw(ulawBuf) {
    if (!this.session || this.closed) return;
    try {
      const pcm8k = ulawBufferToPcm16Buffer(ulawBuf);
      const pcm16k = resampleLinear(pcm8k, 8000, 16000);
      const b64 = pcm16k.toString('base64');
      this.session.sendRealtimeInput({
        audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      });
      log('CALLER_AUDIO', { call_id: this.callId, bytes: ulawBuf.length });
    } catch (e) {
      logError('GEMINI_SEND_ERROR', e, { call_id: this.callId });
    }
  }

  sendText(txt) {
    if (!this.session || this.closed) return;
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: txt }] }],
        turnComplete: true,
      });
      log('GEMINI_PROMPT', { call_id: this.callId, text: txt.slice(0, 120) });
    } catch (e) {
      logError('GEMINI_PROMPT_ERROR', e, { call_id: this.callId });
    }
  }

  sendSlin16(pcm16kBuf) {
    if (!this.session || this.closed) return;
    try {
      const b64 = pcm16kBuf.toString('base64');
      this.session.sendRealtimeInput({
        audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      });
      log('CALLER_AUDIO', { call_id: this.callId, bytes: pcm16kBuf.length });
    } catch (e) {
      logError('GEMINI_SEND_ERROR', e, { call_id: this.callId });
    }
  }

  interrupt() {
    try { this.session?.sendRealtimeInput?.({ activityEnd: {} }); } catch {}
  }

  close() {
    this.closed = true;
    try { this.session?.close?.(); } catch {}
  }
}
