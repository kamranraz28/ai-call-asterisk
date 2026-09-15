import 'dotenv/config';

function need(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  sip: {
    username: process.env.SIP_USERNAME || '',
    password: process.env.SIP_PASSWORD || '',
    server: process.env.SIP_SERVER || '203.76.101.50',
  },
  ari: {
    url: process.env.ARI_URL || 'http://127.0.0.1:8088',
    user: process.env.ARI_USER || 'ari_user',
    password: need('ARI_PASSWORD', 'changeme_ari_pass'),
  },
  gemini: {
    apiKey: need('GEMINI_API_KEY', ''),
    model: process.env.GEMINI_MODEL || 'models/gemini-2.0-flash-exp',
    endpoint: process.env.GEMINI_LIVE_ENDPOINT || '',
  },
  node: {
    host: process.env.NODE_HOST || '0.0.0.0',
    httpPort: parseInt(process.env.NODE_HTTP_PORT || '5410', 10),
    mediaPort: parseInt(process.env.NODE_MEDIA_PORT || '4000', 10),
    externalHost: process.env.NODE_MEDIA_HOST || '127.0.0.1',
  },
  recording: {
    dir: process.env.RECORDING_DIR || './recordings',
    token: process.env.RECORDING_UPLOAD_TOKEN || 'change-me',
  },
  stasisApp: process.env.STASIS_APP || 'gemini-live',
};
