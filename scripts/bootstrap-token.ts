import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
import { NotificacionesApiRepo } from '../src/database/notificaciones-api-repo';

dotenv.config();

const TARGET_URL = 'https://notif.pjn.gov.ar/';
const SS_KEY = 'oidc.user:https://sso.pjn.gov.ar/auth/realms/pjn:pjn-sne';
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

async function main() {
  const headlessEnv = process.env.HEADLESS_MODE;
  const headless = headlessEnv === 'true';
  const username = process.env.PJN_USERNAME;
  const password = process.env.PJN_PASSWORD;
  const auto = !!(username && password);

  console.log(`Modo: ${auto ? 'login automático' : 'login manual (logueate vos)'}`);
  console.log(`Headless: ${headless}`);
  console.log(`Target: ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    if (auto) {
      try {
        await autoLogin(page, username!, password!);
      } catch (err) {
        console.warn(`\nLogin automático falló (${(err as Error).message}).`);
        console.warn('Si hay MFA o captcha, completalo a mano en la ventana del navegador.\n');
      }
    } else {
      console.log('Logueate manualmente en la ventana del navegador.\n');
    }

    console.log(`Esperando token (timeout ${TIMEOUT_MS / 1000}s)...`);
    const deadline = Date.now() + TIMEOUT_MS;
    let raw: string | null = null;
    while (Date.now() < deadline) {
      try {
        raw = await page.evaluate((key) => sessionStorage.getItem(key), SS_KEY);
      } catch {
        // Cross-origin durante redirects: ignorar y reintentar
      }
      if (raw) break;
      await page.waitForTimeout(POLL_MS);
    }

    if (!raw) {
      throw new Error('Timeout esperando login. No se encontró el OIDC user en sessionStorage.');
    }

    const oidcUser = JSON.parse(raw);
    const refreshToken: string | undefined = oidcUser.refresh_token;
    if (!refreshToken) {
      throw new Error('OIDC user encontrado pero sin refresh_token.');
    }

    console.log('\nLogin OK. Refresh token capturado.\n');

    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      try {
        const repo = new NotificacionesApiRepo();
        await repo.setConfig('pjn_refresh_token', refreshToken);
        console.log('refresh_token guardado en Supabase (kv_config). El monitor lo va a leer de ahí.');
        console.log('No hace falta tocar PJN_REFRESH_TOKEN en .env ni en GitHub Secrets.\n');
      } catch (err) {
        console.warn(`Falló persistencia en Supabase: ${(err as Error).message}`);
        console.warn('Usá las líneas de abajo como fallback:\n');
        console.log(`PJN_CLIENT_ID=pjn-sne`);
        console.log(`PJN_REFRESH_TOKEN=${refreshToken}\n`);
      }
    } else {
      console.log('Agregá a tu .env (y/o GitHub Secrets):\n');
      console.log(`PJN_CLIENT_ID=pjn-sne`);
      console.log(`PJN_REFRESH_TOKEN=${refreshToken}\n`);
    }

    console.log('Si en algún momento el monitor falla con "Token is not active", volvé a correr este bootstrap.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Bootstrap falló:', err);
  process.exit(1);
});
