/**
 * Monitor continuo local. Para producción se usa GitHub Actions con `check:now`.
 */

import cron from 'node-cron';
import dotenv from 'dotenv';
import { ApiMonitor } from './monitor/api-monitor';
import { loadUsers } from './users';
import { logger } from './config';

dotenv.config();

async function correrTodos(): Promise<void> {
  const users = loadUsers();
  for (const user of users) {
    const monitor = new ApiMonitor(user);
    try {
      await monitor.initialize();
      await monitor.run();
    } catch (err) {
      logger.error(`[${user.id}] Error en corrida: ${(err as Error).message}`);
    } finally {
      await monitor.cleanup().catch(() => undefined);
    }
  }
}

async function iniciarMonitor() {
  logger.info('Iniciando Monitor (modo API, multi-usuario)...');

  logger.info('Ejecutando verificación inicial...');
  await correrTodos();

  const intervalo = parseInt(process.env.CHECK_INTERVAL_MINUTES || '30', 10);
  const cronExpr = `*/${intervalo} * * * *`;
  logger.info(`Configurando cron cada ${intervalo} minutos: ${cronExpr}`);

  cron.schedule(cronExpr, async () => {
    logger.info('[scheduled] verificación...');
    try {
      await correrTodos();
    } catch (err) {
      logger.error('[scheduled] Error:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  process.on('SIGINT', async () => {
    logger.info('SIGINT, cerrando...');
    process.exit(0);
  });

  process.stdin.resume();
}

iniciarMonitor().catch((err) => {
  logger.error('Error fatal:', err);
  process.exit(1);
});
