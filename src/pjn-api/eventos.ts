import { KeycloakClient } from './keycloak';
import { apiFetch } from './http';
import { Entrada, EntradasPage, ListEntradasParams } from './types';

const BASE = 'https://api.pjn.gov.ar/eventos';

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://portalpjn.pjn.gov.ar',
  Referer: 'https://portalpjn.pjn.gov.ar/',
};

export class EventosClient {
  constructor(private keycloak: KeycloakClient) {}

  async listPage(params: ListEntradasParams = {}): Promise<EntradasPage> {
    const qs = new URLSearchParams({
      page: String(params.page ?? 0),
      pageSize: String(params.pageSize ?? 50),
      categoria: params.categoria ?? 'judicial',
    });

    try {
      const res = await apiFetch(this.keycloak, `${BASE}/?${qs}`, HEADERS);
      return (await res.json()) as EntradasPage;
    } catch (err) {
      const st = (err as { status?: number }).status;
      throw new Error(`list eventos failed ${(err as Error).message}${st === 401 ? ' [401 persistente: probable incidente transitorio del PJN, reintenta la próxima corrida]' : ''}`);
    }
  }

  async getPdf(entradaId: number): Promise<Buffer> {
    try {
      const res = await apiFetch(this.keycloak, `${BASE}/${entradaId}/pdf`, { ...HEADERS, Accept: 'application/pdf' });
      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    } catch (err) {
      throw new Error(`getPdf entrada failed for ${entradaId} ${(err as Error).message}`);
    }
  }

  async listAll(params: ListEntradasParams = {}): Promise<Entrada[]> {
    const items: Entrada[] = [];
    let page = params.page ?? 0;
    while (true) {
      const result = await this.listPage({ ...params, page });
      items.push(...result.items);
      if (!result.hasNext) break;
      page += 1;
    }
    return items;
  }
}
