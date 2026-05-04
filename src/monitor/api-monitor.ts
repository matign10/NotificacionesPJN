import { logger } from '../config';
import { KeycloakClient } from '../pjn-api/keycloak';
import { NotificacionesClient } from '../pjn-api/notificaciones';
import { Notificacion } from '../pjn-api/types';
import { NotificacionesApiRepo } from '../database/notificaciones-api-repo';
import { TelegramBot } from '../telegram/telegram-bot';

export interface ApiMonitorConfig {
  lookbackDays: number;
  pageSize: number;
  enableTelegramNotifications: boolean;
  attachPdf: boolean;
}

export interface ApiMonitorResult {
  success: boolean;
  total: number;
  nuevas: number;
  enviadas: number;
  errores: string[];
  duracionMs: number;
}

export class ApiMonitor {
  private keycloak: KeycloakClient;
  private notifs: NotificacionesClient;
  private repo: NotificacionesApiRepo;
  private telegram: TelegramBot | null = null;
  private cfg: ApiMonitorConfig;
  private telegramReady = false;

  constructor(cfg?: Partial<ApiMonitorConfig>) {
    const refreshToken = process.env.PJN_REFRESH_TOKEN;
    const clientId = process.env.PJN_CLIENT_ID || 'pjn-sne';
    if (!refreshToken) {
      throw new Error('Falta PJN_REFRESH_TOKEN. Corré `npm run bootstrap:token`.');
    }
    this.keycloak = new KeycloakClient({ clientId, refreshToken });
    this.notifs = new NotificacionesClient(this.keycloak);
    this.repo = new NotificacionesApiRepo();

    this.cfg = {
      lookbackDays: parseInt(process.env.LOOKBACK_DAYS || '60', 10),
      pageSize: parseInt(process.env.API_PAGE_SIZE || '50', 10),
      enableTelegramNotifications: process.env.DISABLE_TELEGRAM !== 'true',
      attachPdf: process.env.ATTACH_PDF !== 'false',
      ...cfg,
    };
  }

  async initialize(): Promise<void> {
    logger.info('Inicializando ApiMonitor...');
    await this.repo.ping();
    if (this.cfg.enableTelegramNotifications) {
      this.telegram = new TelegramBot();
      await this.telegram.initialize();
      this.telegramReady = true;
    }
    logger.info('ApiMonitor listo');
  }

  async run(): Promise<ApiMonitorResult> {
    const start = Date.now();
    const result: ApiMonitorResult = {
      success: false,
      total: 0,
      nuevas: 0,
      enviadas: 0,
      errores: [],
      duracionMs: 0,
    };

    try {
      const fechaHasta = new Date();
      const fechaDesde = new Date();
      fechaDesde.setDate(fechaDesde.getDate() - this.cfg.lookbackDays);

      logger.info(`Listando notificaciones RECIBIDAS (lookback ${this.cfg.lookbackDays}d)...`);
      const items = await this.notifs.listAll({
        bandeja: 'RECIBIDAS',
        fechaDesde,
        fechaHasta,
        pageSize: this.cfg.pageSize,
      });
      result.total = items.length;
      logger.info(`API devolvió ${items.length} notificaciones`);

      // Insertar las nuevas (idempotente por PK)
      const nuevas: Notificacion[] = [];
      for (const n of items) {
        try {
          const inserted = await this.repo.insertIfMissing(n);
          if (inserted) nuevas.push(n);
        } catch (err) {
          const msg = `Error al persistir notificación ${n.id}: ${(err as Error).message}`;
          logger.error(msg);
          result.errores.push(msg);
        }
      }
      result.nuevas = nuevas.length;
      logger.info(`Nuevas notificaciones para procesar: ${nuevas.length}`);

      // Procesar pendientes (incluye nuevas + cualquier pendiente de corridas previas)
      const pendientes = await this.repo.getPendientes();
      logger.info(`Total pendientes (incluyendo previas): ${pendientes.length}`);

      for (const row of pendientes) {
        try {
          await this.procesarPendiente(row.notificacion_id, row.raw);
          result.enviadas++;
        } catch (err) {
          const msg = `Error procesando ${row.notificacion_id}: ${(err as Error).message}`;
          logger.error(msg);
          result.errores.push(msg);
        }
      }

      result.success = result.errores.length === 0;
    } catch (err) {
      const msg = `Error fatal: ${(err as Error).message}`;
      logger.error(msg);
      result.errores.push(msg);
    } finally {
      result.duracionMs = Date.now() - start;
      logger.info(
        `Run finalizado en ${result.duracionMs}ms. total=${result.total} nuevas=${result.nuevas} enviadas=${result.enviadas} errores=${result.errores.length}`
      );
    }

    return result;
  }

  private async procesarPendiente(id: number, notif: Notificacion): Promise<void> {
    if (!this.telegramReady || !this.telegram) {
      logger.info(`Telegram deshabilitado, marcando ${id} como enviada igual.`);
      await this.repo.markSent(id);
      return;
    }

    const mensaje = {
      expediente: notif.expediente.numeracion,
      caratula: notif.expediente.caratula,
      fecha: new Date(notif.fecha),
    };

    if (this.cfg.attachPdf) {
      const pdf = await this.notifs.getPdf(id);
      const filename = `notif-${id}.pdf`;
      const sent = await this.telegram.enviarNotificacionConPdf(mensaje, { buffer: pdf, filename });
      if (!sent.success) {
        throw new Error(`Telegram sendDocument falló: ${sent.error}`);
      }
    } else {
      const sent = await this.telegram.enviarNotificacion(mensaje);
      if (!sent.success) {
        throw new Error(`Telegram sendMessage falló: ${sent.error}`);
      }
    }

    await this.repo.markSent(id);
    logger.info(`Notificación ${id} (${notif.expediente.numeracion}) enviada y marcada.`);
  }

  async cleanup(): Promise<void> {
    if (this.telegramReady && this.telegram) {
      await this.telegram.detenerBot().catch(() => undefined);
    }
  }
}
