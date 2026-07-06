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

async function checkUser(user: PjnUser): Promise<void> {
  console.log(`\n======== usuario "${user.id}" ========`);
  const repo = new NotificacionesApiRepo(user.id);
  let token: string;
  try {
    token = await tokenParaUsuario(user, repo);
  } catch (err) {
    console.log(`  [${user.id}] NO se pudo obtener token: ${(err as Error).message.slice(0, 120)}`);
    return;
  }

  const c = decodeClaims(token);
  const sneRoles = (c.resource_access as Record<string, { roles?: string[] }> | undefined)?.['pjn-sne']?.roles ?? [];
  console.log(`  roles pjn-sne=${JSON.stringify(sneRoles)}`);

  const desde = new Date(); desde.setDate(desde.getDate() - 60);
  const hasta = new Date();
  const qs = `bandeja=RECIBIDAS&fechaDesde=${fmt(desde)}&fechaHasta=${fmt(hasta)}&page=0&pageSize=1`;
  const listUrl = `${API}/notificaciones?${qs}`;
  const codes: Record<number, number> = {};
  let sampleErr = '';
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(listUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json, text/plain, */*',
          Origin: BASE, Referer: `${BASE}/recibidas`,
        },
      });
      codes[res.status] = (codes[res.status] ?? 0) + 1;
      const body = await res.text();
      if (!res.ok && !sampleErr) sampleErr = body.slice(0, 120);
    } catch (err) {
      codes[0] = (codes[0] ?? 0) + 1;
      if (!sampleErr) sampleErr = (err as Error).message;
    }
  }
  console.log(`  [${user.id}] notif list x5 -> ${JSON.stringify(codes)}`);
  if (sampleErr) console.log(`    muestra fallo: ${sampleErr}`);
}

async function main() {
  const only = process.env.DIAG_USER;
  const users = loadUsers().filter((u) => !only || u.id === only);
  console.log(`=== DIAG notif API — usuarios: ${users.map((u) => u.id).join(', ')} ===`);
  for (const u of users) {
    try {
      await checkUser(u);
    } catch (err) {
      console.log(`[${u.id}] error inesperado: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  console.log('\n=== fin DIAG ===');
}

main().catch((err) => {
  console.error('DIAG fatal:', (err as Error).message);
  process.exit(1);
});
