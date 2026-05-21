/**
 * Verificación inmediata. Usado por GitHub Actions y para pruebas manuales.
 *
 * Multi-usuario: itera sobre cada usuario PJN definido en PJN_USERS (o el
 * usuario único legacy). Cada usuario corre aislado en su propio try/catch
 * con su propio bot de Telegram, así un fallo de uno no frena a los demás.
 *
 * Si la sesión Keycloak de un usuario quedó invalidada, corremos su
 * auto-bootstrap headless (con sus PJN_USERNAME/PJN_PASSWORD) y reintentamos
 * una vez. Si tampoco funciona, mandamos UNA alerta por su Telegram cada 6h.
 */

import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { ApiMonitor, ApiMonitorResult } from './monitor/api-monitor';
import { isSessionDeadError, runBootstrap } from './bootstrap/auto-bootstrap';
import { NotificacionesApiRepo } from './database/notificaciones-api-repo';
import { TelegramBot } from './telegram/telegram-bot';
import { loadUsers, alertKey, PjnUser } from './users';
import { logger } from './config';

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

async function runOnce(user: PjnUser): Promise<{ result: ApiMonitorResult; sessionDead: boolean }> {
  const monitor = new ApiMonitor(user);
  try {
    await monitor.initialize();
    const result = await monitor.run();
    const sessionDead = result.errores.some(isSessionDeadError);
    return { result, sessionDead };
  } finally {
    await monitor.cleanup().catch(() => undefined);
  }
}

async function tryAlertSessionDead(user: PjnUser, reason: string): Promise<void> {
  if (process.env.DISABLE_TELEGRAM === 'true') return;

  try {
    const repo = new NotificacionesApiRepo(user.id);
    const key = alertKey(user.id);
    const lastRaw = await repo.getConfig(key);
    const last = lastRaw ? Number(lastRaw) : 0;
    const now = Date.now();
    if (now - last < ALERT_COOLDOWN_MS) {
      logger.info(`[${user.id}] Alerta sesión muerta silenciada por ratelimit (última hace ${Math.round((now - last) / 60000)} min).`);
      return;
    }

    const bot = new TelegramBot({ botToken: user.telegramBotToken, chatId: user.telegramChatId });
    await bot.initialize();
    await bot.enviarAlertaSesionMuerta(reason);
    await bot.detenerBot().catch(() => undefined);
    await repo.setConfig(key, String(now));
    logger.info(`[${user.id}] Alerta de sesión muerta enviada por Telegram.`);
  } catch (err) {
    logger.error(`[${user.id}] No se pudo enviar alerta de sesión muerta: ${(err as Error).message}`);
  }
}

async function procesarUsuario(user: PjnUser): Promise<ApiMonitorResult> {
  logger.info(`===== Usuario "${user.id}" =====`);
  let { result, sessionDead } = await runOnce(user);
  let recoveryFailed = false;
  let recoveryReason = '';

  if (sessionDead && user.pjnUsername && user.pjnPassword) {
    logger.warn(`[${user.id}] Sesión Keycloak invalidada. Disparando auto-bootstrap headless...`);
    try {
      await runBootstrap({ userId: user.id, username: user.pjnUsername, password: user.pjnPassword, headless: true });
      logger.info(`[${user.id}] Auto-bootstrap OK. Reintentando corrida...`);
      ({ result, sessionDead } = await runOnce(user));
      if (sessionDead) {
        recoveryFailed = true;
        recoveryReason = 'Auto-bootstrap completo pero la sesión siguió invalidada al reintentar.';
      }
    } catch (err) {
      recoveryFailed = true;
      recoveryReason = `Auto-bootstrap falló: ${(err as Error).message}`;
      logger.error(`[${user.id}] ${recoveryReason}`);
      result.errores.push(recoveryReason);
      result.success = false;
    }
  } else if (sessionDead) {
    recoveryFailed = true;
    recoveryReason = 'Sesión muerta y faltan pjnUsername/pjnPassword para auto-recovery.';
    logger.error(`[${user.id}] ${recoveryReason}`);
  }

  if (recoveryFailed) {
    await tryAlertSessionDead(user, recoveryReason);
  }

  console.log(`
📊 [${user.id}] ${result.success ? '✅ EXITOSA' : '❌ CON ERRORES'} — ${result.duracionMs}ms
🔔 Notificaciones — total=${result.total} nuevas=${result.nuevas} enviadas=${result.enviadas}
📥 Entradas        — total=${result.totalEntradas} nuevas=${result.nuevasEntradas} enviadas=${result.enviadasEntradas}`);
  if (result.errores.length > 0) {
    console.log(`❌ [${user.id}] Errores:`);
    result.errores.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }

  return result;
}

async function main() {
  console.log(`
╔════════════════════════════════════════╗
║     PJN - VERIFICACIÓN MULTI-USUARIO   ║
║     ${dayjs().format('DD/MM/YYYY HH:mm:ss')}          ║
╚════════════════════════════════════════╝
  `);

  const users = loadUsers();
  logger.info(`Usuarios a procesar: ${users.map((u) => u.id).join(', ')}`);

  let anyFailed = false;
  for (const user of users) {
    try {
      const result = await procesarUsuario(user);
      if (!result.success) anyFailed = true;
    } catch (err) {
      // Aislamiento: el fallo de un usuario no frena a los demás.
      anyFailed = true;
      logger.error(`[${user.id}] Error fatal procesando usuario: ${(err as Error).message}`);
      console.error(`💥 [${user.id}] ERROR FATAL:`, err);
    }
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  logger.error('Error fatal en check-now:', err);
  console.error('💥 ERROR FATAL:', err);
  process.exit(1);
});
