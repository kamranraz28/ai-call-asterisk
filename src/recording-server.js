import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { log, logError } from './logger.js';
import { config } from './config.js';

export function createRecordingApp() {
  const app = express();
  app.use(express.json());

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const d = new Date().toISOString().slice(0, 10);
      const dir = path.join(config.recording.dir, d);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const callId = req.body?.call_id || req.query?.call_id || `call_${Date.now()}`;
      cb(null, `${callId}.wav`);
    },
  });
  const upload = multer({ storage });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', activeCalls: global.activeCalls ?? 0, uptime: process.uptime() });
  });

  app.post('/api/recordings', (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${config.recording.token}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }, upload.single('recording'), (req, res) => {
    const { call_id, caller, destination, started_at, ended_at, duration } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'missing recording file' });
    log('RECORDING_UPLOADED', { call_id, caller, destination, duration, file: file.path, size: file.size });
    res.json({ ok: true, call_id, file: file.path });
  });

  app.use((err, req, res, next) => {
    logError('RECORDING_ERROR', err, {});
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
