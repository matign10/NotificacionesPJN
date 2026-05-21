import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../config';
import { NotificacionesApiRepo } from '../database/notificaciones-api-repo';
import { rtKeySne, rtKeyPortal } from '../users';

const LOGS_DIR = path.join(process.cwd(), 'logs');
function ensureLogsDir(): string {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  return LOGS_DIR;
}

async function dumpPage(page: Page, label: string): Promise<void> {
  try {
    const dir = ensureLogsDir();
    const safe = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(dir, `bootstrap-${safe}-${ts}.png`), fullPage: true });
    const html = await page.content().catch(() => '');
    fs.writeFileSync(path.join(dir, `bootstrap-${safe}-${ts}.html`), html);
    logger.info(`Diagnostico: dump guardado para ${label}. URL=${page.url()} title="${await page.title().catch(() => '')}"`);
  } catch (err) {
    logger.warn(`No se pudo dumpear pagina ${label}: ${(err as Error).message}`);
  }
}

interface AppTarget {
  label: string;
  url: string;
  ssKey: string;
  // Construye la key namespaceada en kv_config para un usuario dado.
  kvKey: (userId: string) => string;
}

export const BOOTSTRAP_TARGETS: AppTarget[] = [
  {
    label: 'pjn-sne (notificaciones)',
    url: 'https://notif.pjn.gov.ar/',
    ssKey: 'oidc.user:https://sso.pjn.gov.ar/auth/realms/pjn:pjn-sne',
    kvKey: rtKeySne,
  },
  {
    label: 'pjn-portal (entradas)',
    url: 'https://portalpjn.pjn.gov.ar/',
    ssKey: 'oidc.user:https://sso.pjn.gov.ar/auth/realms/pjn:pjn-portal',
    kvKey: rtKeyPortal,
  },
];

const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

export interface BootstrapOptions {
  userId?: string;
  username?: string;
  password?: string;
  headless?: boolean;
  persist?: boolean;
}

async function autoLogin(page: Page, username: string, password: string): Promise<void> {
  logger.info(`autoLogin: esperando form. URL=${page.url()}`);
  await page.waitForSelector('input[name="username"], input[id="username"]', { timeout: 30_000 });
  await page.locator('input[name="username"], input[id="username"]').first().fill(username);
  await page.locator('input[name="password"], input[id="password"]').first().fill(password);
  logger.info(`autoLogin: enviando credenciales`);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  // Captura mensajes de error tipicos de Keycloak (usuario/clave invalido,
  // captcha, cuenta bloqueada).
  const possibleErrorSelectors = [
    '#input-error',
    '.kc-feedback-text',
    '.alert-error',
    '.pf-c-alert__title',
    '[class*="error"]',
  ];
  for (const sel of possibleErrorSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      const text = (await el.textContent().catch(() => null))?.trim();
      if (text) {
        logger.warn(`autoLogin: mensaje del form (${sel}): ${text}`);
      }
    }
  }
  logger.info(`autoLogin: tras submit URL=${page.url()}`);
}

async function captureRt(
  context: BrowserContext,
  target: AppTarget,
  autoCreds: { user: string; pass: string } | null
): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    // Esperar a que la cadena de redirects del SSO termine antes de
    // decidir si la pagina es de login o estamos ya autenticados.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);

    // Deteccion robusta: si la URL es la del endpoint de auth de Keycloak,
    // es la pagina de login si o si — independiente de si el form ya
    // renderizo. Si no, fallback al chequeo de input.
    const onLoginUrl = /\/auth\/realms\/pjn\/protocol\/openid-connect\/auth/.test(page.url());
    const inputCount = await page.locator('input[name="username"], input[id="username"]').count();
    const isLoginPage = onLoginUrl || inputCount > 0;
    logger.info(`captureRt(${target.label}): URL=${page.url()} onLoginUrl=${onLoginUrl} inputCount=${inputCount} -> isLoginPage=${isLoginPage}`);
    if (isLoginPage) {
      if (autoCreds) {
        try {
          await autoLogin(page, autoCreds.user, autoCreds.pass);
        } catch (err) {
          logger.warn(`Login automatico fallo para ${target.label}: ${(err as Error).message}`);
        }
      } else {
        logger.info(`Login manual requerido para ${target.label}.`);
      }
    } else {
      logger.info(`Sesion SSO ya activa para ${target.label}.`);
    }

    const deadline = Date.now() + TIMEOUT_MS;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = await page.evaluate(
          // page.evaluate runs in browser context where sessionStorage exists.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (key: string) => (globalThis as any).sessionStorage.getItem(key) as string | null,
          target.ssKey
        );
      } catch {
        // cross-origin during redirects
      }
      if (raw) break;
      await page.waitForTimeout(POLL_MS);
    }
    if (!raw) {
      await dumpPage(page, `timeout-${target.label}`);
      throw new Error(`Timeout esperando token de ${target.label}. Ver logs/ para screenshot.`);
    }

    const oidc = JSON.parse(raw);
    const rt: string | undefined = oidc.refresh_token;
    if (!rt) throw new Error(`OIDC user de ${target.label} sin refresh_token.`);
    return rt;
  } finally {
    await page.close();
  }
}

/**
 * Captura los refresh_tokens de todos los clients y los persiste en
 * Supabase (kv_config). Usado tanto por el script CLI como por el
 * auto-recovery del monitor cuando la sesion Keycloak se invalida.
 */
export async function runBootstrap(opts: BootstrapOptions = {}): Promise<Record<string, string>> {
  const userId = opts.userId ?? 'matias';
  const username = opts.username ?? process.env.PJN_USERNAME;
  const password = opts.password ?? process.env.PJN_PASSWORD;
  const headless = opts.headless ?? process.env.HEADLESS_MODE !== 'false';
  const persist = opts.persist ?? true;
  const autoCreds = username && password ? { user: username, pass: password } : null;

  logger.info(`Bootstrap usuario "${userId}": modo=${autoCreds ? 'auto' : 'manual'} headless=${headless}`);

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  const tokens: Record<string, string> = {};
  try {
    for (const target of BOOTSTRAP_TARGETS) {
      const rt = await captureRt(context, target, autoCreds);
      tokens[target.kvKey(userId)] = rt;
      logger.info(`Bootstrap OK: ${target.label} (usuario ${userId})`);
    }
  } finally {
    await browser.close();
  }

  if (persist && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const repo = new NotificacionesApiRepo(userId);
    for (const [key, value] of Object.entries(tokens)) {
      await repo.setConfig(key, value);
      logger.info(`Bootstrap: persistido ${key} en kv_config.`);
    }
  }

  return tokens;
}

export function isSessionDeadError(err: unknown): boolean {
  const msg = typeof err === 'string'
    ? err
    : (err as Error)?.message ?? String(err ?? '');
  return /Token is not active|invalid_grant/i.test(msg);
}
