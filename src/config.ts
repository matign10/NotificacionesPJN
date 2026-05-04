import dotenv from 'dotenv';
import winston from 'winston';
import path from 'path';

dotenv.config();

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/app.log'),
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

export function checkConfig(): boolean {
  const required = [
    'PJN_REFRESH_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    logger.error('Faltan variables de entorno: ' + missing.join(', '));
    return false;
  }

  return true;
}

export const config = {
  pjn: {
    clientId: process.env.PJN_CLIENT_ID || 'pjn-sne',
    refreshToken: process.env.PJN_REFRESH_TOKEN || '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    chatId: process.env.TELEGRAM_CHAT_ID!,
  },
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
  },
  app: {
    checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES || '30', 10),
    lookbackDays: parseInt(process.env.LOOKBACK_DAYS || '60', 10),
    attachPdf: process.env.ATTACH_PDF !== 'false',
    disableTelegram: process.env.DISABLE_TELEGRAM === 'true',
    dataDir: path.join(__dirname, '../data'),
    logsDir: path.join(__dirname, '../logs'),
  },
};
