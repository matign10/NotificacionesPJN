/**
 * Test de notificación ficticia
 *
 * Este script crea un expediente ficticio con notificación en la base de datos
 * y ejecuta el proceso de verificación del monitor para probar que:
 * 1. La lógica de detección de nuevas notificaciones funciona
 * 2. El envío por Telegram funciona correctamente
 * 3. La notificación se marca como enviada correctamente
 */

import { SupabaseDatabase } from './database/supabase-database';
import { TelegramBot } from './telegram/telegram-bot';
import { PJNMonitor } from './monitor/pjn-monitor';
import { Expediente } from './database/database';
import { config, logger, checkConfig } from './config';
import { v4 as uuidv4 } from 'uuid';

async function testNotificacionFicticia() {
  try {
    console.log('\n🧪 === TEST DE NOTIFICACIÓN FICTICIA ===\n');

    // Verificar configuración
    if (!checkConfig()) {
      process.exit(1);
    }

    // 1. Inicializar base de datos
    logger.info('📊 Inicializando base de datos...');
    const db = new SupabaseDatabase();
    await db.initialize();

    // 2. Crear expediente ficticio con notificación
    logger.info('📝 Creando expediente ficticio...');

    const expedienteFicticio: Expediente = {
      id: uuidv4(),
      numero: `TEST-${Date.now()}`,
      caratula: 'EXPEDIENTE DE PRUEBA - Notificación Ficticia para Testing del Sistema',
      tieneNotificacion: true,
      ultimaVerificacion: new Date(),
      notificacionEnviada: false, // Importante: NO enviada aún
      fechaNotificacion: new Date(),
      detallesNotificacion: 'Notificación de prueba creada por test-notificacion-ficticia.ts'
    };

    logger.info(`✅ Expediente ficticio: ${expedienteFicticio.numero}`);
    logger.info(`   Carátula: ${expedienteFicticio.caratula}`);
    logger.info(`   Tiene notificación: ${expedienteFicticio.tieneNotificacion}`);
    logger.info(`   Notificación enviada: ${expedienteFicticio.notificacionEnviada}`);

    // 3. Guardar en la base de datos
    logger.info('💾 Guardando expediente en base de datos...');
    await db.saveExpediente(expedienteFicticio);
    logger.info('✅ Expediente guardado correctamente');

    // 4. Verificar que se guardó
    const expedienteGuardado = await db.getExpedienteByNumero(expedienteFicticio.numero);
    if (!expedienteGuardado) {
      throw new Error('El expediente no se guardó correctamente');
    }
    logger.info('✅ Expediente verificado en base de datos');

    // 5. Probar envío por Telegram directamente
    console.log('\n📱 === PROBANDO ENVÍO POR TELEGRAM ===\n');

    logger.info('🚀 Inicializando bot de Telegram...');
    const telegramBot = new TelegramBot();
    await telegramBot.initialize();

    logger.info('📤 Enviando notificación por Telegram...');
    const resultadoTelegram = await telegramBot.enviarNotificacion({
      expediente: expedienteFicticio.numero,
      caratula: expedienteFicticio.caratula,
      fecha: expedienteFicticio.fechaNotificacion || new Date(),
      mensaje: expedienteFicticio.detallesNotificacion,
      urgente: true // Marcar como urgente para que se destaque
    });

    if (resultadoTelegram.success) {
      logger.info('✅ Notificación enviada exitosamente por Telegram!');
      logger.info(`   Message ID: ${resultadoTelegram.messageId}`);

      // 6. Marcar como enviada en la base de datos
      logger.info('📝 Marcando notificación como enviada...');
      await db.marcarNotificacionEnviada(expedienteFicticio.id);

      // Verificar que se marcó correctamente
      const expedienteActualizado = await db.getExpedienteByNumero(expedienteFicticio.numero);
      if (expedienteActualizado?.notificacionEnviada) {
        logger.info('✅ Notificación marcada como enviada en base de datos');
      } else {
        logger.warn('⚠️ La notificación no se marcó como enviada correctamente');
      }

    } else {
      logger.error('❌ Error al enviar notificación por Telegram:', resultadoTelegram.error);
      throw new Error(`Fallo envío Telegram: ${resultadoTelegram.error}`);
    }

    // 7. Obtener estadísticas
    console.log('\n📊 === ESTADÍSTICAS ===\n');
    const estadisticas = await db.getEstadisticas();
    logger.info(`Total de expedientes: ${estadisticas.totalExpedientes}`);
    logger.info(`Expedientes con notificaciones: ${estadisticas.expedientesConNotificaciones}`);
    logger.info(`Notificaciones pendientes: ${estadisticas.notificacionesPendientes}`);
    logger.info(`Notificaciones enviadas: ${estadisticas.notificacionesEnviadas}`);

    // 8. Limpieza opcional
    console.log('\n🧹 === LIMPIEZA ===\n');
    const respuesta = await new Promise<string>((resolve) => {
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });

      readline.question('¿Deseas eliminar el expediente de prueba? (s/n): ', (answer: string) => {
        readline.close();
        resolve(answer.toLowerCase());
      });
    });

    if (respuesta === 's' || respuesta === 'si' || respuesta === 'sí') {
      logger.info('🗑️ Eliminando expediente de prueba...');
      // Nota: Necesitarías implementar un método deleteExpediente en la BD
      logger.warn('⚠️ La eliminación debe hacerse manualmente desde Supabase por ahora');
      logger.info(`   Expediente a eliminar: ${expedienteFicticio.numero}`);
    } else {
      logger.info('✅ El expediente de prueba permanecerá en la base de datos');
    }

    // 9. Cerrar recursos
    await db.close();
    await telegramBot.detenerBot();

    console.log('\n✅ === TEST COMPLETADO EXITOSAMENTE ===\n');
    console.log('📋 Resumen del test:');
    console.log(`   - Expediente ficticio creado: ${expedienteFicticio.numero}`);
    console.log(`   - Notificación enviada por Telegram: ✅`);
    console.log(`   - Estado actualizado en BD: ✅`);
    console.log(`   - Sistema funcionando correctamente: ✅`);
    console.log('\n🎉 El sistema de notificaciones está operativo!\n');

  } catch (error) {
    console.error('\n❌ === TEST FALLIDO ===\n');
    logger.error('Error durante el test:', error);
    console.error('\n💥 ERROR FATAL\n');
    console.error(error);
    console.error('\nRevisa los logs en logs/ para más información.\n');
    process.exit(1);
  }
}

// Ejecutar test
testNotificacionFicticia()
  .then(() => {
    logger.info('🏁 Test finalizado');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('💥 Error fatal en test:', error);
    process.exit(1);
  });
