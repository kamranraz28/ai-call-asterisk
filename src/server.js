import ari from 'ari-client';
import { config } from './config.js';
import { log, logError } from './logger.js';
import { createRecordingApp } from './recording-server.js';
import { MediaSession } from './media-session.js';

global.activeCalls = 0;
const sessions = new Map();

const recApp = createRecordingApp();
recApp.listen(config.node.httpPort, config.node.host, () => {
  log('HTTP_READY', { host: config.node.host, port: config.node.httpPort });
});

function connectAri(attempt=1){
ari.connect(config.ari.url, config.ari.user, config.ari.password, (err, client) => {
  if (err) {
    logError('ARI_CONNECT_FAILED', err, { url: config.ari.url, attempt });
    setTimeout(()=>connectAri(attempt+1), 5000);
    return;
  }
  log('ARI_CONNECTED', { url: config.ari.url });

  client.on('StasisStart', async (event, channel) => {
    if (!event.args || event.args.length === 0) {
      log('IGNORE_EXTERNAL', { channel: channel.id, name: channel.name });
      return;
    }
    if (channel.name && channel.name.includes('UnicastRTP')) return;
    const callId = event.args?.[0] || channel.id;
    const caller = channel.caller?.number || 'unknown';
    log('CALL_INCOMING', { call_id: callId, channel: channel.id, caller });
    global.activeCalls++;
    const session = new MediaSession({ callId, channelId: channel.id, ari: client });
    sessions.set(channel.id, session);
    channel.on('StasisEnd', async () => {
      log('CALL_ENDED', { call_id: callId, channel: channel.id });
      global.activeCalls = Math.max(0, global.activeCalls - 1);
      await session.destroy();
      sessions.delete(channel.id);
    });
    await session.start();
  });

  client.on('StasisEnd', (event, channel) => {
    const s = sessions.get(channel.id);
    if (s) s.destroy();
  });

  client.start(config.stasisApp);

});
}
connectAri();
process.on('SIGINT', () => { log('SHUTDOWN', {}); process.exit(0); });
process.on('uncaughtException', (e) => logError('UNCAUGHT', e, {}));
process.on('unhandledRejection', (e) => logError('UNHANDLED_REJECTION', e, {}));
