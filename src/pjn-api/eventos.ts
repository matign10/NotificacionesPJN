import { KeycloakClient } from './keycloak';
import { Entrada, EntradasPage, ListEntradasParams } from './types';

const BASE = 'https://api.pjn.gov.ar/eventos';

export class EventosClient {
  constructor(private keycloak: KeycloakClient) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.keycloak.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://portalpjn.pjn.gov.ar',
      Referer: 'https://portalpjn.pjn.gov.ar/',
    };
  }

  async listPage(params: ListEntradasParams = {}): Promise<EntradasPage> {
    const qs = new URLSearchParams({
      page: String(params.page ?? 0),
      pageSize: String(params.pageSize ?? 50),
      categoria: params.categoria ?? 'judicial',
    });

    const res = await fetch(`${BASE}/?${qs}`, {
      headers: await this.authHeaders(),
    });

    if (!res.ok) {
      throw new Error(`list eventos failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as EntradasPage;
  }

  async getPdf(entradaId: number): Promise<Buffer> {
    const res = await fetch(`${BASE}/${entradaId}/pdf`, {
      headers: {
        ...(await this.authHeaders()),
        Accept: 'application/pdf',
      },
    });
    if (!res.ok) {
      throw new Error(`getPdf entrada failed for ${entradaId} (${res.status}): ${await res.text()}`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
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
