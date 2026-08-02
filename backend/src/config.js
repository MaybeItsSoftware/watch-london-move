const dotenv = require('dotenv');

dotenv.config();

function parseCsv(raw) {
  return (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const trainLines = parseCsv(
  process.env.TFL_TRAIN_LINES ||
    'bakerloo,central,circle,district,elizabeth,hammersmith-city,jubilee,metropolitan,northern,piccadilly,victoria,waterloo-city,london-overground,dlr,tram',
);

const busLines = parseCsv(process.env.TFL_BUS_LINES || '11,12,24,29,38,55,73,390');
const corsOrigins = parseCsv(process.env.CORS_ORIGIN || 'http://localhost:5173');

module.exports = {
  port: Number(process.env.PORT || 4010),
  corsOrigins,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  emitIntervalMs: Number(process.env.EMIT_INTERVAL_MS || 10000),
  busCacheWindowMs: Number(process.env.BUS_CACHE_WINDOW_MS || 10000),
  trainCacheWindowMs: Number(process.env.TRAIN_CACHE_WINDOW_MS || 10000),
  retryCount: Number(process.env.RETRY_COUNT || 3),
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 1000),
  trainLines,
  busLines,
  tflApiBaseUrl: process.env.TFL_API_BASE_URL || 'https://api.tfl.gov.uk',
  tflAppId: process.env.TFL_APP_ID || '',
  tflAppKey: process.env.TFL_APP_KEY || '',
};
