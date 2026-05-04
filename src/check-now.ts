/**
 * Verificación inmediata. Usado por GitHub Actions y para pruebas manuales.
 */

import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { ApiMonitor } from './monitor/api-monitor';
import { logger } from './config';

dotenv.config();

async function main() {
  console.log(`
╔════════════════════════════════════════╗
║     PJN - VERIFICACIÓN MANUAL          ║
║     ${dayjs().format('DD/MM/YYYY HH:mm:ss')}          ║
╚════════════════════════════════════════╝
  `);

  const monitor = new ApiMonitor();
  try {
    await monitor.initialize();
    const result = await monitor.run();
    console.log(`
📊 RESULTADOS

${result.success ? '✅' : '❌'} Estado: ${result.success ? 'EXITOSA' : 'CON ERRORES'}
⏱️  Duración: ${result.duracionMs}ms
📋 Total notificaciones API: ${result.total}
🆕 Nuevas: ${result.nuevas}
📱 Enviadas a Telegram: ${result.enviadas}
    `);
    if (result.errores.length > 0) {
      console.log('❌ Errores:');
      result.errores.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    }
    process.exit(result.success ? 0 : 1);
  } finally {
    await monitor.cleanup().catch(() => undefined);
  }
}

main().catch((err) => {
  logger.error('Error fatal en check-now:', err);
  console.error('💥 ERROR FATAL:', err);
  process.exit(1);
});
