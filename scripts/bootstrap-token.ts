import { chromium, BrowserContext, Page } from 'playwright';
import dotenv from 'dotenv';
import { NotificacionesApiRepo } from '../src/database/notificaciones-api-repo';

dotenv.config();

interface AppTarget {
  label: string;
  url: string;
  ssKey: string;
  kvKey: string;
}

const TARGETS: AppTarget[] = [
  {
    label: 'pjn-sne (notificaciones)',
    url: 'https://notif.pjn.gov.ar/',
    ssKey: 'oidc.user:https://sso.pjn.gov.ar/auth/realms/pjn:pjn-sne',
    kvKey: 'pjn_refresh_token_sne',
  },
  {
    label: 'pjn-portal (entradas)',
    url: 'https://portalpjn.pjn.gov.ar/',
    ssKey: 'oidc.user:https://sso.pjn.gov.ar/auth/realms/pjn:pjn-portal',
    kvKey: 'pjn_refresh_token_portal',
  },
];

const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

async function autoLogin(page: Page, username: string, password: string): Promise<void> {
  console.log('Esperando formulario de login del SSO...');
  await page.waitForSelector('input[name="username"], input[id="username"]', { timeout: 30_000 });

  const userField = page.locator('input[name="username"], input[id="username"]').first();
  const passField = page.locator('input[name="password"], input[id="password"]').first();

  await userField.fill(username);
  await passField.fill(password);

  console.log('Enviando credenciales...');
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
}

async function captureRt(context: BrowserContext, target: AppTarget, autoCreds: { user: string; pass: string } | null): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' });

    const isLoginPage = await page.locator('input[name="username"], input[id="username"]').count() > 0;
    if (isLoginPage) {
      if (autoCreds) {
        try {
          await autoLogin(page, autoCreds.user, autoCreds.pass);
        } catch (err) {
          console.warn(`Login automatico fallo (${(err as Error).message}). Completá manualmente.`);
        }
      } else {
        console.log('Logueate manualmente en la ventana del navegador.');
      }
    } else {
      console.log(`Sesion SSO ya activa para ${target.label}.`);
    }

    console.log(`Esperando token de ${target.label} (timeout ${TIMEOUT_MS / 1000}s)...`);
    const deadline = Date.now() + TIMEOUT_MS;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = await page.evaluate((key) => sessionStorage.getItem(key), target.ssKey);
      } catch {
        // Cross-origin durante redirects
      }
      if (raw) break;
      await page.waitForTimeout(POLL_MS);
    }

    if (!raw) {
      throw new Error(`Timeout esperando token de ${target.label}.`);
    }

    const oidcUser = JSON.parse(raw);
    const refreshToken: string | undefined = oidcUser.refresh_token;
    if (!refreshToken) {
      throw new Error(`OIDC user de ${target.label} sin refresh_token.`);
    }
    console.log(`OK ${target.label}: refresh_token capturado.`);
    return refreshToken;
  } finally {
    await page.close();
  }
}

async function main() {
  const headless = process.env.HEADLESS_MODE === 'true';
  const username = process.env.PJN_USERNAME;
  const password = process.env.PJN_PASSWORD;
  const autoCreds = username && password ? { user: username, pass: password } : null;

  console.log(`Modo: ${autoCreds ? 'login automatico' : 'login manual'}`);
  console.log(`Headless: ${headless}\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });

  const tokens: Record<string, string> = {};
  try {
    for (const target of TARGETS) {
      const rt = await captureRt(context, target, autoCreds);
      tokens[target.kvKey] = rt;
    }
  } finally {
    await browser.close();
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const repo = new NotificacionesApiRepo();
    for (const [key, value] of Object.entries(tokens)) {
      await repo.setConfig(key, value);
      console.log(`Guardado en Supabase (kv_config): ${key}`);
    }
    console.log('\nListo. El monitor lee ambos RT desde Supabase.');
  } else {
    console.log('\nSin Supabase configurado. RTs capturados:');
    for (const [key, value] of Object.entries(tokens)) {
      console.log(`${key}=${value}`);
    }
  }

  console.log('\nSi el monitor falla con "Token is not active", volve a correr este bootstrap.');
}

main().catch((err) => {
  console.error('Bootstrap fallo:', err);
  process.exit(1);
});
