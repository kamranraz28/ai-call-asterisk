import { createRtpSocket } from './rtp.js';
import { GeminiLiveSession } from './gemini-live.js';
import { log, logError } from './logger.js';
import { config } from './config.js';
import { pcm16BufferToUlawBuffer, ulawBufferToPcm16Buffer, resampleLinear, dcBlocker, normalizeSoft } from './codecs.js';
import fs from 'fs';

export class MediaSession {
  constructor({ callId, channelId, ari }) {
    this.callId = callId;
    this.channelId = channelId;
    this.ari = ari;
    this.externalChannel = null;
    this.bridge = null;
    this.rtp = null;
    this.gemini = null;
    this.jitterBuf = [];
    this.talking = false;
    this.lastVoiceAt = 0;
    this.destroyed = false;
  }

  async start() {
    const basePort = config.node.mediaPort;
    const tryPort = basePort + Math.floor(Math.random()*500);
    this.rtp = createRtpSocket(tryPort, (ulaw) => this.onCallerAudio(ulaw));
    await new Promise(r => this.rtp.sock.once('listening', r));
    const actualPort = this.rtp.getPort();
    const externalHost = `${config.node.externalHost}:${actualPort}`;

    this.liveFailed = false;
    this.fallbackTimer = null;
    this.gemini = new GeminiLiveSession({
      callId: this.callId,
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      onAudioOut: (ulawChunk) => this.sendToAsterisk(ulawChunk),
      onInterrupted: () => this.onBargeIn(),
      onClose: (e) => {
        const r = String(e?.reason||'');
        if (r.includes('bidiGenerateContent') || r.includes('not found')) {
          this.liveFailed = true;
          log('LIVE_FAILED_FALLBACK', { call_id: this.callId });
        }
      }
    });

    try {
      await this.gemini.connect();
    } catch (e) {
      logError('GEMINI_CONNECT_FAILED', e, { call_id: this.callId });
      setTimeout(()=> this.sendFallback(), 800);
    }
    setTimeout(()=> { if(!this.audioReceived) this.sendFallback(); }, 3500);

    try {
      this.bridge = await this.ari.bridges.create({ type: 'mixing' });
      await this.bridge.addChannel({ channel: this.channelId });
      log('MEDIA_CONNECTED', { call_id: this.callId, bridge: this.bridge.id });

      this.externalChannel = await this.ari.channels.externalMedia({
        app: config.stasisApp,
        external_host: externalHost,
        format: 'ulaw',
        transport: 'udp',
        encapsulation: 'rtp',
      });
      await this.bridge.addChannel({ channel: this.externalChannel.id });
      log('EXTERNAL_MEDIA_CREATED', { call_id: this.callId, external_host: externalHost, channel: this.externalChannel.id });
      try {
        const v = await this.ari.channels.getChannelVar({ channelId: this.externalChannel.id, variable: 'UNICASTRTP_LOCAL_PORT' });
        const lp = parseInt(v.value||v,10);
        if (lp) { this.rtp.setRemote('127.0.0.1', lp); log('RTP_REMOTE_SET', { call_id: this.callId, remote: `127.0.0.1:${lp}` }); }
      } catch(e){ logError('RTP_REMOTE_FAILED', e, { call_id: this.callId }); }
      setTimeout(()=> this.sendGreeting(), 400);

      this.externalChannel.on('StasisEnd', () => this.destroy());
    } catch (e) {
      logError('ARI_SETUP_FAILED', e, { call_id: this.callId });
      this.destroy();
    }
  }

  onCallerAudio(payload) {
    const now = Date.now();
    const pcm = ulawBufferToPcm16Buffer(payload);
    let sum = 0;
    for(let i=0;i<pcm.length;i+=2) sum += Math.abs(pcm.readInt16LE(i));
    const avg = sum / (pcm.length/2);
    const isVoice = avg > 80;
    if (avg > 10) log('CALLER_AUDIO_CHK', { call_id: this.callId, avg: Math.round(avg), isVoice, talking: this.talking });

    if (isVoice) {
      this.lastVoiceAt = now;
      if (!this.talking) {
        this.talking = true;
        log('AI_INTERRUPTED', { call_id: this.callId });
        this.jitterBuf = [];
        this.flushOut();
        try { this.gemini?.interrupt(); } catch {}
        if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
      }
    } else if (this.talking && now - this.lastVoiceAt > 400) {
      this.talking = false;
      log('TALKING_END', { call_id: this.callId });
      if (this.liveFailed && !this.fallbackTimer) {
        this.fallbackTimer = setTimeout(()=> this.handleFallbackTurn(), 900);
        log('FALLBACK_TIMER_SET', { call_id: this.callId });
      }
    }

    if (this.jitterBuf.length > 10) this.jitterBuf.shift();
    if (!this.liveFailed) {
      this.gemini?.sendUlaw(payload);
    } else {
      if (!this.fallbackBuf) this.fallbackBuf = [];
      this.fallbackBuf.push(payload);
      if (this.fallbackBuf.length > 150) this.fallbackBuf.shift();
    }
  }

  async handleFallbackTurn() {
    this.fallbackTimer = null;
    if (this.destroyed) return;
    log('FALLBACK_TURN', { call_id: this.callId, buffered: this.fallbackBuf?.length||0 });
    if (!this.fallbackBuf || this.fallbackBuf.length < 5) {
      await this.speakText("I didn't catch that, could you repeat?");
      return;
    }
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
      const allUlaw = Buffer.concat(this.fallbackBuf);
      const pcm8k = ulawBufferToPcm16Buffer(allUlaw);
      const pcm16k = resampleLinear(pcm8k, 8000, 16000);
      const b64 = pcm16k.toString('base64');
      log('FALLBACK_TRANSCRIBE', { call_id: this.callId, bytes: pcm16k.length });
      const resp = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: b64 }}, { text: "You are a helpful phone assistant. Transcribe the user's speech and answer concisely in under 25 words, conversational for phone." }]}]
      });
      const txt = resp.text?.trim() || "How may I help you further?";
      log('FALLBACK_LLM', { call_id: this.callId, text: txt.slice(0,120) });
      this.fallbackBuf = [];
      await this.speakText(txt);
    } catch(e){
      logError('FALLBACK_LLM_FAILED', e, { call_id: this.callId });
      const texts = ["Thanks for your message. How may I help you further?", "I hear you. Please tell me more."];
      await this.speakText(texts[Math.floor(Math.random()*texts.length)]);
    }
  }

  async speakText(txt) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
      try {
        const resp = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ parts: [{ text: txt }]}],
          config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
        });
        const b64 = resp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || resp.candidates?.[0]?.content?.parts?.find(p=>p.inlineData)?.inlineData?.data;
        if (b64) {
          const pcm24k = Buffer.from(b64, 'base64');
          const pcm8k = dcBlocker(normalizeSoft(resampleLinear(pcm24k, 24000, 8000), 0.7));
          let ulaw = pcm16BufferToUlawBuffer(pcm8k);
          const rem = ulaw.length % 160;
          if (rem !== 0) ulaw = Buffer.concat([ulaw, Buffer.alloc(160 - rem, 0x7f)]);
          log('TTS_SENT_GEMINI', { call_id: this.callId, text: txt, bytes: ulaw.length });
          for(let i=0;i<ulaw.length;i+=160){
            this.enqueueAudio(ulaw.subarray(i,i+160));
          }
          return;
        }
      } catch(e){ logError('GEMINI_TTS_FAILED', e, { call_id: this.callId }); }
      const { spawnSync } = await import('child_process');
      const tmpWav = `/tmp/tts_${this.callId}.wav`;
      const tmpUlaw = `/tmp/tts_${this.callId}.ulaw`;
      const r1 = spawnSync('espeak', ['-v', 'en+m3', '-s', '135', '-a', '200', txt, '--stdout'], { encoding: 'buffer', maxBuffer: 10*1024*1024 });
      if (r1.status !== 0) throw new Error('espeak failed');
      fs.writeFileSync(tmpWav, r1.stdout);
      const r2 = spawnSync('sox', [tmpWav, '-r', '8000', '-c', '1', '-t', 'ul', tmpUlaw], { encoding: 'buffer' });
      if (r2.status !== 0) throw new Error('sox failed '+r2.stderr);
      const data = fs.readFileSync(tmpUlaw);
      log('TTS_SENT_ESPEAK', { call_id: this.callId, text: txt, bytes: data.length });
      for(let i=0;i<data.length;i+=160){
        this.enqueueAudio(data.subarray(i,i+160));
      }
      try{ fs.unlinkSync(tmpWav); try{fs.unlinkSync(tmpUlaw);}catch{} } catch {}
    } catch(e){
      logError('TTS_FAILED', e, { call_id: this.callId });
      this.sendFallback();
    }
  }

  onBargeIn() {
    this.jitterBuf = [];
    this.flushOut();
  }

  sendToAsterisk(ulawChunk) {
    if (this.destroyed) return;
    this.audioReceived = true;
    if (this.greetingSent && !this.greetingSpoken) this.markGreetingSpoken();
    this.enqueueAudio(ulawChunk);
  }

  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(()=> {
      if (this.destroyed) { clearInterval(this.ticker); this.ticker = null; return; }
      if (!this.rtp) return;
      if (this.outQueue && this.outQueue.length > 0) {
        const c = this.outQueue.shift();
        this.rtp.sendUlaw(c);
      }
    }, 20);
  }

  enqueueAudio(ulawChunk) {
    if (this.destroyed) return;
    if (!this.outQueue) this.outQueue = [];
    if (ulawChunk && ulawChunk.length) this.outQueue.push(ulawChunk);
    this.startTicker();
  }

  flushOut() {
    if (this.outQueue) this.outQueue = [];
  }

  sendFallback() {
    if (this.destroyed || this.fallbackSent) return;
    this.fallbackSent = true;
    log('FALLBACK_AUDIO', { call_id: this.callId });
    const sr = 8000;
    const dur = 1.5;
    const samples = Math.floor(sr * dur);
    const pcm = Buffer.alloc(samples*2);
    for(let i=0;i<samples;i++){
      const t = i/sr;
      const f = 440 + (t<0.7?0:220);
      const s = Math.sin(2*Math.PI*f*t)*12000 * (1 - t/dur*0.5);
      pcm.writeInt16LE(s|0, i*2);
    }
    const ulaw = pcm16BufferToUlawBuffer(pcm);
    for(let i=0;i<ulaw.length;i+=160){
      this.enqueueAudio(ulaw.subarray(i,i+160));
    }
  }

  sendGreeting() {
    if (this.destroyed || this.greetingSent) return;
    this.greetingSent = true;
    this.audioReceived = true;
    log('GREETING', { call_id: this.callId });
    if (this.gemini && this.gemini.opened && !this.liveFailed) {
      this.gemini.sendText('Start the call. Greet the caller warmly and ask "How may I help you today?" in one short sentence.');
      if (this.greetingWatcher) clearTimeout(this.greetingWatcher);
      this.greetingWatcher = setTimeout(()=> {
        if (!this.greetingSpoken && !this.liveFailed) {
          this.liveFailed = true;
          this.speakText("How may I help you today?");
        }
      }, 4000);
    } else {
      this.speakText("How may I help you today?");
    }
  }

  markGreetingSpoken() { this.greetingSpoken = true; }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.greetingWatcher) clearTimeout(this.greetingWatcher);
    log('CALL_ENDED', { call_id: this.callId });
    try { this.gemini?.close(); } catch {}
    try { this.rtp?.sock.close(); } catch {}
    try { if (this.bridge) await this.bridge.destroy(); } catch {}
    try { if (this.externalChannel) await this.externalChannel.hangup(); } catch {}
  }
}
