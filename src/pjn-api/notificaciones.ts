import { KeycloakClient } from './keycloak';
import { apiFetch } from './http';
import { Bandeja, ListNotificacionesParams, Notificacion, NotificacionesPage } from './types';

const BASE = 'https://notif.pjn.gov.ar/api';

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://notif.pjn.gov.ar',
  Referer: 'https://notif.pjn.gov.ar/recibidas',
};

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

export class NotificacionesClient {
  constructor(private keycloak: KeycloakClient) {}

  async listPage(params: ListNotificacionesParams): Promise<NotificacionesPage> {
    const qs = new URLSearchParams({
      bandeja: params.bandeja ?? 'RECIBIDAS',
      fechaDesde: formatDate(params.fechaDesde),
      fechaHasta: formatDate(params.fechaHasta),
      page: String(params.page ?? 0),
      pageSize: String(params.pageSize ?? 50),
    });

    try {
      const res = await apiFetch(this.keycloak, `${BASE}/notificaciones?${qs}`, HEADERS);
      return (await res.json()) as NotificacionesPage;
    } catch (err) {
      const st = (err as { status?: number }).status;
      throw new Error(`list notificaciones failed ${(err as Error).message}${st === 401 ? ' [401 persistente: probable incidente transitorio del PJN, reintenta la próxima corrida]' : ''}`);
    }
  }

  async listAll(params: ListNotificacionesParams): Promise<Notificacion[]> {
    const items: Notificacion[] = [];
    let page = params.page ?? 0;
    while (true) {
      const result = await this.listPage({ ...params, page });
      items.push(...result.items);
      if (!result.hasNext) break;
      page += 1;
    }
    return items;
  }

  async getPdf(notificacionId: number, bandeja: Bandeja = 'RECIBIDAS'): Promise<Buffer> {
    try {
      const res = await apiFetch(this.keycloak, `${BASE}/notificaciones/${bandeja}/${notificacionId}/pdf`, HEADERS);
      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    } catch (err) {
      throw new Error(`getPdf failed for ${notificacionId} ${(err as Error).message}`);
    }
  }
}
