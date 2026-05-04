/**
 * Monitor continuo local. Para producción se usa GitHub Actions con `check:now`.
 */

import cron from 'node-cron';
import dotenv from 'dotenv';
import { ApiMonitor } from './monitor/api-monitor';
import { logger } from './config';

dotenv.config();

async function iniciarMonitor() {
  logger.info('Iniciando Monitor (modo API)...');

  const monitor = new ApiMonitor();
  await monitor.initialize();

  logger.info('Ejecutando verificación inicial...');
  await monitor.run();

  const intervalo = parseInt(process.env.CHECK_INTERVAL_MINUTES || '30', 10);
  const cronExpr = `*/${intervalo} * * * *`;
  logger.info(`Configurando cron cada ${intervalo} minutos: ${cronExpr}`);

  cron.schedule(cronExpr, async () => {
    logger.info('[scheduled] verificación...');
    try {
      await monitor.run();
    } catch (err) {
      logger.error('[scheduled] Error:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  process.on('SIGINT', async () => {
    logger.info('SIGINT, cerrando...');
    await monitor.cleanup().catch(() => undefined);
    process.exit(0);
  });

  process.stdin.resume();
}

iniciarMonitor().catch((err) => {
  logger.error('Error fatal:', err);
  process.exit(1);
});
