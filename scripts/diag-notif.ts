/**
 * Diagnóstico del 401 credenciales_incorrectas del API de notificaciones.
 *
 * NO corre en el sandbox de Claude (la política de red bloquea el PJN).
 * Está pensado para correr en GitHub Actions (workflow diag.yml) o local,
 * donde SÍ hay salida a notif.pjn.gov.ar.
 *
 * Reproduce el GET /api/notificaciones con un token real y prueba una
 * matriz de variantes para aislar qué cambió del lado del PJN. Imprime
 * SOLO metadata (status, claims no sensibles, snippets) — nunca el token
 * ni PII.
 */
import dotenv from 'dotenv';
import { KeycloakClient } from '../src/pjn-api/keycloak';
import { NotificacionesApiRepo } from '../src/database/notificaciones-api-repo';
import { loadUsers, rtKeySne } from '../src/users';

dotenv.config();

const BASE = 'https://notif.pjn.gov.ar';
const API = `${BASE}/api`;

function fmt(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${d.getFullYear()}`;
}

function decodeClaims(jwt: string): Record<string, unknown> {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function attempt(label: string, url: string, headers: Record<string, string>): Promise<void> {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    const snippet = body.slice(0, 180).replace(/\s+/g, ' ');
    console.log(`\n[${label}] HTTP ${res.status}`);
    const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    console.log(`  server=${res.headers.get('server') ?? '-'} via=${res.headers.get('via') ?? '-'} set-cookie=${setCookie.length}`);
    console.log(`  body: ${snippet}`);
  } catch (err) {
    console.log(`\n[${label}] ERROR ${(err as Error).message}`);
  }
}

async function main() {
  const userId = process.env.DIAG_USER || loadUsers()[0].id;
  console.log(`=== DIAG notif API — usuario "${userId}" ===`);

  const repo = new NotificacionesApiRepo(userId);
  const rt = await repo.getConfig(rtKeySne(userId));
  if (!rt) throw new Error(`No hay ${rtKeySne(userId)} en kv_config.`);

  const kc = new KeycloakClient({
    clientId: 'pjn-sne',
    refreshToken: rt,
    onRefresh: async (nrt) => { await repo.setConfig(rtKeySne(userId), nrt); },
  });
  const token = await kc.getAccessToken();

  // Claims NO sensibles del access token (sin sub/nombre/cuit/token).
  const c = decodeClaims(token);
  const exp = c.exp ? new Date((c.exp as number) * 1000).toISOString() : '?';
  const iat = c.iat ? new Date((c.iat as number) * 1000).toISOString() : '?';
  const realmRoles = (c.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
  const resourceKeys = Object.keys((c.resource_access as Record<string, unknown>) ?? {});
  const sneRoles = (c.resource_access as Record<string, { roles?: string[] }> | undefined)?.['pjn-sne']?.roles ?? [];
  console.log('--- access token claims ---');
  console.log(`  iss=${c.iss}`);
  console.log(`  azp=${c.azp}  aud=${JSON.stringify(c.aud)}`);
  console.log(`  scope=${c.scope}`);
  console.log(`  typ=${c.typ}  iat=${iat}  exp=${exp}`);
  console.log(`  realm_access.roles=${JSON.stringify(realmRoles)}`);
  console.log(`  resource_access keys=${JSON.stringify(resourceKeys)}`);
  console.log(`  resource_access['pjn-sne'].roles=${JSON.stringify(sneRoles)}`);

  const desde = new Date(); desde.setDate(desde.getDate() - 60);
  const hasta = new Date();
  const qs = `bandeja=RECIBIDAS&fechaDesde=${fmt(desde)}&fechaHasta=${fmt(hasta)}&page=0&pageSize=1`;
  const listUrl = `${API}/notificaciones?${qs}`;
  const auth = `Bearer ${token}`;

  // A0 — baseline (headers actuales del cliente)
  await attempt('A0 baseline', listUrl, {
    Authorization: auth,
    Accept: 'application/json, text/plain, */*',
    Origin: BASE,
    Referer: `${BASE}/recibidas`,
  });

  // A1 — cookie jar: primero visitar la SPA para capturar cookies (F5/WAF), reenviarlas
  let cookieHeader = '';
  try {
    const home = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' } });
    const sc = (home.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    cookieHeader = sc.map((s) => s.split(';')[0]).join('; ');
    console.log(`\n[cookie-jar] home HTTP ${home.status} — cookies capturadas: ${sc.length} (${cookieHeader.slice(0, 80)})`);
  } catch (err) {
    console.log(`\n[cookie-jar] home ERROR ${(err as Error).message}`);
  }
  await attempt('A1 con-cookies', listUrl, {
    Authorization: auth,
    Accept: 'application/json, text/plain, */*',
    Origin: BASE,
    Referer: `${BASE}/recibidas`,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  });

  // A2 — Referer raíz
  await attempt('A2 referer-root', listUrl, {
    Authorization: auth, Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: `${BASE}/`,
  });

  // A3 — sin Origin ni Referer
  await attempt('A3 sin-origin-referer', listUrl, {
    Authorization: auth, Accept: 'application/json, text/plain, */*',
  });

  // A4 — con X-Requested-With
  await attempt('A4 xhr', listUrl, {
    Authorization: auth, Accept: 'application/json, text/plain, */*', Origin: BASE,
    Referer: `${BASE}/recibidas`, 'X-Requested-With': 'XMLHttpRequest',
  });

  // A5 — Accept json estricto + User-Agent de browser
  await attempt('A5 ua-browser', listUrl, {
    Authorization: auth, Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Origin: BASE, Referer: `${BASE}/recibidas`,
  });

  // A6 — endpoint sin query (por si cambió el shape/params)
  await attempt('A6 sin-query', `${API}/notificaciones?bandeja=RECIBIDAS`, {
    Authorization: auth, Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: `${BASE}/recibidas`,
  });

  // A7 — endpoint usuario/info (para saber si CUALQUIER endpoint del API acepta el token)
  await attempt('A7 usuario-info', `${API}/usuario/info`, {
    Authorization: auth, Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: `${BASE}/`,
  });

  console.log('\n=== fin DIAG ===');
}

main().catch((err) => {
  console.error('DIAG fatal:', (err as Error).message);
  process.exit(1);
});
