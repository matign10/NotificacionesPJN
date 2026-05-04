import { KeycloakClient } from './keycloak';
import { Bandeja, ListNotificacionesParams, Notificacion, NotificacionesPage } from './types';

const BASE = 'https://notif.pjn.gov.ar/api';

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

export class NotificacionesClient {
  constructor(private keycloak: KeycloakClient) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.keycloak.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://notif.pjn.gov.ar',
      Referer: 'https://notif.pjn.gov.ar/recibidas',
    };
  }

  async listPage(params: ListNotificacionesParams): Promise<NotificacionesPage> {
    const qs = new URLSearchParams({
      bandeja: params.bandeja ?? 'RECIBIDAS',
      fechaDesde: formatDate(params.fechaDesde),
      fechaHasta: formatDate(params.fechaHasta),
      page: String(params.page ?? 0),
      pageSize: String(params.pageSize ?? 50),
    });

    const res = await fetch(`${BASE}/notificaciones?${qs}`, {
      headers: await this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`list notificaciones failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as NotificacionesPage;
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
    const res = await fetch(`${BASE}/notificaciones/${bandeja}/${notificacionId}/pdf`, {
      headers: await this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`getPdf failed for ${notificacionId} (${res.status}): ${await res.text()}`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }
}
