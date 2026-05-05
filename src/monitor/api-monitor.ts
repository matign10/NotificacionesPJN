import { logger } from '../config';
import { KeycloakClient } from '../pjn-api/keycloak';
import { NotificacionesClient } from '../pjn-api/notificaciones';
import { EventosClient } from '../pjn-api/eventos';
import { Entrada, Notificacion } from '../pjn-api/types';
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
  totalEntradas: number;
  nuevasEntradas: number;
  enviadasEntradas: number;
  errores: string[];
  duracionMs: number;
}

export class ApiMonitor {
  private keycloakSne: KeycloakClient | null = null;
  private keycloakPortal: KeycloakClient | null = null;
  private notifs: NotificacionesClient | null = null;
  private eventos: EventosClient | null = null;
  private repo: NotificacionesApiRepo;
  private telegram: TelegramBot | null = null;
  private cfg: ApiMonitorConfig;
  private telegramReady = false;

  constructor(cfg?: Partial<ApiMonitorConfig>) {
    this.repo = new NotificacionesApiRepo();

    this.cfg = {
      lookbackDays: parseInt(process.env.LOOKBACK_DAYS || '60', 10),
      pageSize: parseInt(process.env.API_PAGE_SIZE || '50', 10),
      enableTelegramNotifications: process.env.DISABLE_TELEGRAM !== 'true',
      attachPdf: process.env.ATTACH_PDF !== 'false',
      ...cfg,
    };
  }

  private async buildKeycloak(clientId: string, kvKey: string, label: string): Promise<KeycloakClient | null> {
    const stored = await this.repo.getConfig(kvKey);
    if (!stored) {
      logger.warn(`No hay refresh_token persistido para ${label} (kv_config:${kvKey}). El flujo de ${label} se omite hasta que corras bootstrap:token.`);
      return null;
    }
    return new KeycloakClient({
      clientId,
      refreshToken: stored,
      onRefresh: async (newRT) => {
        await this.repo.setConfig(kvKey, newRT);
        logger.info(`refresh_token (${label}) rotado y persistido.`);
      },
    });
  }

  async initialize(): Promise<void> {
    logger.info('Inicializando ApiMonitor...');
    await this.repo.ping();

    // Dos clients distintos en Keycloak: pjn-sne para notificaciones y
    // pjn-portal para eventos/entradas. Cada uno tiene su propio
    // refresh_token, que rota en cada uso.
    this.keycloakSne = await this.buildKeycloak('pjn-sne', 'pjn_refresh_token_sne', 'notif');
    this.keycloakPortal = await this.buildKeycloak('pjn-portal', 'pjn_refresh_token_portal', 'portal');

    if (!this.keycloakSne && !this.keycloakPortal) {
      throw new Error('No hay refresh_token para ningún client en Supabase. Corré `npm run bootstrap:token`.');
    }

    if (this.keycloakSne) this.notifs = new NotificacionesClient(this.keycloakSne);
    if (this.keycloakPortal) this.eventos = new EventosClient(this.keycloakPortal);

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
      totalEntradas: 0,
      nuevasEntradas: 0,
      enviadasEntradas: 0,
      errores: [],
      duracionMs: 0,
    };

    try {
      const fechaHasta = new Date();
      const fechaDesde = new Date();
      fechaDesde.setDate(fechaDesde.getDate() - this.cfg.lookbackDays);

      if (!this.notifs) {
        logger.info('Skipping notificaciones (sin RT de pjn-sne).');
      } else {
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

      }

      if (!this.eventos) {
        logger.info('Skipping entradas (sin RT de pjn-portal). Corré bootstrap:token.');
      } else {
      logger.info('Listando entradas (eventos judicial)...');
      const entradas = await this.eventos.listAll({
        categoria: 'judicial',
        pageSize: this.cfg.pageSize,
      });
      result.totalEntradas = entradas.length;
      logger.info(`API devolvió ${entradas.length} entradas`);

      const nuevasEntradas: Entrada[] = [];
      for (const e of entradas) {
        try {
          const inserted = await this.repo.insertEntradaIfMissing(e);
          if (inserted) nuevasEntradas.push(e);
        } catch (err) {
          const msg = `Error al persistir entrada ${e.id}: ${(err as Error).message}`;
          logger.error(msg);
          result.errores.push(msg);
        }
      }
      result.nuevasEntradas = nuevasEntradas.length;
      logger.info(`Nuevas entradas para procesar: ${nuevasEntradas.length}`);

      const entradasPendientes = await this.repo.getEntradasPendientes();
      logger.info(`Total entradas pendientes (incluyendo previas): ${entradasPendientes.length}`);

      for (const row of entradasPendientes) {
        try {
          await this.procesarEntradaPendiente(row.entrada_id, row.raw);
          result.enviadasEntradas++;
        } catch (err) {
          const msg = `Error procesando entrada ${row.entrada_id}: ${(err as Error).message}`;
          logger.error(msg);
          result.errores.push(msg);
        }
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
        `Run finalizado en ${result.duracionMs}ms. ` +
        `notif total=${result.total} nuevas=${result.nuevas} enviadas=${result.enviadas} | ` +
        `entradas total=${result.totalEntradas} nuevas=${result.nuevasEntradas} enviadas=${result.enviadasEntradas} | ` +
        `errores=${result.errores.length}`
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
      const pdf = await this.notifs!.getPdf(id);
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

  private async procesarEntradaPendiente(id: number, entrada: Entrada): Promise<void> {
    if (!this.telegramReady || !this.telegram) {
      logger.info(`Telegram deshabilitado, marcando entrada ${id} como enviada igual.`);
      await this.repo.markEntradaSent(id);
      return;
    }

    const link = entrada.link?.app === 'pjn-scw'
      ? `https://scw.pjn.gov.ar${entrada.link.url}`
      : entrada.link?.url;

    const mensaje = {
      expedienteClave: entrada.payload?.claveExpediente ?? '',
      caratula: entrada.payload?.caratulaExpediente ?? '(sin carátula)',
      fecha: new Date(entrada.fechaAccion),
      tipoEvento: entrada.tipo,
      link,
    };

    if (this.cfg.attachPdf && entrada.hasDocument) {
      try {
        const pdf = await this.eventos!.getPdf(id);
        const filename = `entrada-${id}.pdf`;
        const sent = await this.telegram.enviarEntradaConPdf(mensaje, { buffer: pdf, filename });
        if (!sent.success) {
          throw new Error(`Telegram sendDocument falló: ${sent.error}`);
        }
      } catch (err) {
        // Si el PDF falla, mandamos al menos el mensaje en texto para no perder el aviso.
        logger.warn(`PDF de entrada ${id} no disponible (${(err as Error).message}), enviando solo texto.`);
        const sent = await this.telegram.enviarEntrada(mensaje);
        if (!sent.success) throw new Error(`Telegram sendMessage falló: ${sent.error}`);
      }
    } else {
      const sent = await this.telegram.enviarEntrada(mensaje);
      if (!sent.success) throw new Error(`Telegram sendMessage falló: ${sent.error}`);
    }

    await this.repo.markEntradaSent(id);
    logger.info(`Entrada ${id} (${entrada.payload?.claveExpediente}) enviada y marcada.`);
  }

  async cleanup(): Promise<void> {
    if (this.telegramReady && this.telegram) {
      await this.telegram.detenerBot().catch(() => undefined);
    }
  }
}
