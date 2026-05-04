import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';

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
    console.log('Agregá a tu .env (y/o GitHub Secrets):\n');
    console.log(`PJN_CLIENT_ID=pjn-sne`);
    console.log(`PJN_REFRESH_TOKEN=${refreshToken}\n`);
    console.log('El refresh token se rota en cada uso. Si el monitor falla con "Keycloak refresh failed",');
    console.log('volvé a correr `npm run bootstrap:token`.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Bootstrap falló:', err);
  process.exit(1);
});
