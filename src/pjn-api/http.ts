import { KeycloakClient } from './keycloak';

// Statuses que tratamos como transitorios: un blip del backend del PJN o de
// su balanceador F5 (visto el 2026-07-05: 401 credenciales_incorrectas a
// tokens válidos, recuperado solo). Reintentamos con backoff corto y, en el
// primer reintento, forzamos un token fresco por si el problema fuera el
// token en sí.
const RETRIABLE = new Set([401, 403, 429, 500, 502, 503, 504]);

export interface ApiFetchResult {
  res: Response;
}

/**
 * fetch autenticado contra el API del PJN con reintentos ante fallos
 * transitorios. Devuelve la Response OK; si tras los reintentos sigue
 * fallando, lanza un Error con status y body para que el caller lo formatee.
 */
export async function apiFetch(
  keycloak: KeycloakClient,
  url: string,
  baseHeaders: Record<string, string>,
  opts: { retries?: number } = {}
): Promise<Response> {
  const retries = opts.retries ?? 3;
  let token = await keycloak.getAccessToken();
  let refreshed = false;
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
    });
    if (res.ok) return res;

    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');

    if (!RETRIABLE.has(res.status) || attempt === retries) break;

    // Primer reintento: forzar token nuevo (por si el token estaba en la
    // ventana de gracia o el nodo lo rechazó). Siguientes: reusar y reintentar
    // (puede caer en otro nodo del clúster).
    if (!refreshed) {
      try {
        token = await keycloak.refresh();
      } catch {
        // si el refresh falla, seguimos con el token actual
      }
      refreshed = true;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }

  const err = new Error(`(${lastStatus}): ${lastBody}`) as Error & { status?: number };
  err.status = lastStatus;
  throw err;
}
