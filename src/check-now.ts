/**
 * Verificación inmediata. Usado por GitHub Actions y para pruebas manuales.
 *
 * Si la sesion Keycloak quedo invalidada (p.ej. el usuario se logueo manual
 * en otro browser), corremos automaticamente el bootstrap headless con
 * PJN_USERNAME/PJN_PASSWORD y reintentamos una sola vez. Si tambien eso
 * falla (captcha, MFA, password cambiado, etc.) mandamos UNA alerta por
 * Telegram cada 6 horas para que el usuario corra bootstrap manual.
 */

import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { ApiMonitor, ApiMonitorResult } from './monitor/api-monitor';
import { isSessionDeadError, runBootstrap } from './bootstrap/auto-bootstrap';
import { NotificacionesApiRepo } from './database/notificaciones-api-repo';
import { TelegramBot } from './telegram/telegram-bot';
import { logger } from './config';

dotenv.config();

const ALERT_KV_KEY = 'last_session_dead_alert_at';
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

async function runOnce(): Promise<{ result: ApiMonitorResult; sessionDead: boolean }> {
  const monitor = new ApiMonitor();
  try {
    await monitor.initialize();
    const result = await monitor.run();
    const sessionDead = result.errores.some(isSessionDeadError);
    return { result, sessionDead };
  } finally {
    await monitor.cleanup().catch(() => undefined);
  }
}

async function tryAlertSessionDead(reason: string): Promise<void> {
  if (process.env.DISABLE_TELEGRAM === 'true') return;
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  try {
    const repo = new NotificacionesApiRepo();
    const lastRaw = await repo.getConfig(ALERT_KV_KEY);
    const last = lastRaw ? Number(lastRaw) : 0;
    const now = Date.now();
    if (now - last < ALERT_COOLDOWN_MS) {
      logger.info(`Alerta sesion muerta silenciada por ratelimit (ultima hace ${Math.round((now - last) / 60000)} min).`);
      return;
    }

    const bot = new TelegramBot();
    await bot.initialize();
    await bot.enviarAlertaSesionMuerta(reason);
    await bot.detenerBot().catch(() => undefined);
    await repo.setConfig(ALERT_KV_KEY, String(now));
    logger.info('Alerta de sesion muerta enviada por Telegram.');
  } catch (err) {
    logger.error(`No se pudo enviar alerta de sesion muerta: ${(err as Error).message}`);
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════╗
║     PJN - VERIFICACIÓN MANUAL          ║
║     ${dayjs().format('DD/MM/YYYY HH:mm:ss')}          ║
╚════════════════════════════════════════╝
  `);

  let { result, sessionDead } = await runOnce();
  let recoveryFailed = false;
  let recoveryReason = '';

  if (sessionDead && process.env.PJN_USERNAME && process.env.PJN_PASSWORD) {
    logger.warn('Sesion Keycloak invalidada. Disparando auto-bootstrap headless...');
    try {
      await runBootstrap({ headless: true });
      logger.info('Auto-bootstrap OK. Reintentando corrida...');
      ({ result, sessionDead } = await runOnce());
      if (sessionDead) {
        recoveryFailed = true;
        recoveryReason = 'Auto-bootstrap completo pero la sesion siguio invalidada al reintentar.';
      }
    } catch (err) {
      recoveryFailed = true;
      recoveryReason = `Auto-bootstrap fallo: ${(err as Error).message}`;
      logger.error(recoveryReason);
      result.errores.push(recoveryReason);
      result.success = false;
    }
  } else if (sessionDead) {
    recoveryFailed = true;
    recoveryReason = 'Sesion muerta y faltan PJN_USERNAME/PJN_PASSWORD para auto-recovery.';
    logger.error(recoveryReason);
  }

  if (recoveryFailed) {
    await tryAlertSessionDead(recoveryReason);
  }

  console.log(`
📊 RESULTADOS

${result.success ? '✅' : '❌'} Estado: ${result.success ? 'EXITOSA' : 'CON ERRORES'}
⏱️  Duración: ${result.duracionMs}ms
🔔 Notificaciones — total=${result.total} nuevas=${result.nuevas} enviadas=${result.enviadas}
📥 Entradas        — total=${result.totalEntradas} nuevas=${result.nuevasEntradas} enviadas=${result.enviadasEntradas}
    `);
  if (result.errores.length > 0) {
    console.log('❌ Errores:');
    result.errores.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  logger.error('Error fatal en check-now:', err);
  console.error('💥 ERROR FATAL:', err);
  process.exit(1);
});
