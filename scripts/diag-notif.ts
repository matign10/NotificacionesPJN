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
import { loadUsers, rtKeySne, PjnUser } from '../src/users';
import { runBootstrap, isSessionDeadError } from '../src/bootstrap/auto-bootstrap';

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

async function tokenParaUsuario(user: PjnUser, repo: NotificacionesApiRepo): Promise<string> {
  const buildKc = (rt: string) =>
    new KeycloakClient({
      clientId: 'pjn-sne',
      refreshToken: rt,
      onRefresh: async (nrt) => { await repo.setConfig(rtKeySne(user.id), nrt); },
    });

  let rt = await repo.getConfig(rtKeySne(user.id));
  if (!rt) throw new Error(`No hay ${rtKeySne(user.id)} en kv_config.`);

  try {
    return await buildKc(rt).getAccessToken();
  } catch (err) {
    if (!isSessionDeadError(err)) throw err;
    // RT stale: re-bootstrap headless como hace el monitor, y reintentar.
    console.log('  RT stale, corriendo auto-bootstrap headless...');
    await runBootstrap({ userId: user.id, username: user.pjnUsername, password: user.pjnPassword, headless: true });
    rt = await repo.getConfig(rtKeySne(user.id));
    if (!rt) throw new Error('Bootstrap no dejó RT en kv_config.');
    return await buildKc(rt).getAccessToken();
  }
}

async function main() {
  const userId = process.env.DIAG_USER || loadUsers()[0].id;
  const user = loadUsers().find((u) => u.id === userId) ?? loadUsers()[0];
  console.log(`=== DIAG notif API — usuario "${user.id}" ===`);

  const repo = new NotificacionesApiRepo(user.id);
  const token = await tokenParaUsuario(user, repo);

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
  const baseHeaders = (cookie?: string): Record<string, string> => ({
    Authorization: auth,
    Accept: 'application/json, text/plain, */*',
    Origin: BASE,
    Referer: `${BASE}/recibidas`,
    ...(cookie ? { Cookie: cookie } : {}),
  });

  const N = 30;

  // Capturar la cookie F5 de persistencia visitando la home.
  let f5Cookie = '';
  try {
    const home = await fetch(`${BASE}/`, { headers: { Accept: 'text/html' } });
    const sc = (home.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    f5Cookie = sc.map((s) => s.split(';')[0]).join('; ');
    console.log(`\n[cookie F5] ${sc.length} cookie(s): ${f5Cookie.slice(0, 60)}...`);
  } catch (err) {
    console.log(`\n[cookie F5] ERROR ${(err as Error).message}`);
  }

  // BURST A — sin cookie (como el cliente actual). Rebota entre nodos F5.
  const stats = async (label: string, cookie?: string) => {
    const codes: Record<number, number> = {};
    let sample401 = '';
    for (let i = 0; i < N; i++) {
      try {
        const res = await fetch(listUrl, { headers: baseHeaders(cookie) });
        codes[res.status] = (codes[res.status] ?? 0) + 1;
        if (res.status === 401 && !sample401) sample401 = (await res.text()).slice(0, 140);
        else await res.text();
      } catch (err) {
        codes[0] = (codes[0] ?? 0) + 1;
        if (!sample401) sample401 = `ERR ${(err as Error).message}`;
      }
    }
    console.log(`\n[${label}] ${N} requests -> ${JSON.stringify(codes)}`);
    if (sample401) console.log(`  muestra fallo: ${sample401}`);
  };

  await stats('BURST-A sin-cookie', undefined);
  await stats('BURST-B con-cookie-F5', f5Cookie || undefined);

  console.log('\n=== fin DIAG ===');
}

main().catch((err) => {
  console.error('DIAG fatal:', (err as Error).message);
  process.exit(1);
});
