/**
 * Verificación inmediata. Usado por GitHub Actions y para pruebas manuales.
 *
 * Si la sesion Keycloak quedo invalidada (p.ej. el usuario se logueo manual
 * en otro browser), corremos automaticamente el bootstrap headless con
 * PJN_USERNAME/PJN_PASSWORD y reintentamos una sola vez.
 */

import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { ApiMonitor, ApiMonitorResult } from './monitor/api-monitor';
import { isSessionDeadError, runBootstrap } from './bootstrap/auto-bootstrap';
import { logger } from './config';

dotenv.config();

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

async function main() {
  console.log(`
╔════════════════════════════════════════╗
║     PJN - VERIFICACIÓN MANUAL          ║
║     ${dayjs().format('DD/MM/YYYY HH:mm:ss')}          ║
╚════════════════════════════════════════╝
  `);

  let { result, sessionDead } = await runOnce();

  if (sessionDead && process.env.PJN_USERNAME && process.env.PJN_PASSWORD) {
    logger.warn('Sesion Keycloak invalidada. Disparando auto-bootstrap headless...');
    try {
      await runBootstrap({ headless: true });
      logger.info('Auto-bootstrap OK. Reintentando corrida...');
      ({ result, sessionDead } = await runOnce());
    } catch (err) {
      logger.error(`Auto-bootstrap fallo: ${(err as Error).message}`);
      result.errores.push(`auto-bootstrap fallo: ${(err as Error).message}`);
      result.success = false;
    }
  } else if (sessionDead) {
    logger.error('Sesion muerta y no hay PJN_USERNAME/PASSWORD para auto-recovery.');
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
