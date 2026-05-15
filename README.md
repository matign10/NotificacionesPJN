# PJN Notificaciones Monitor

Monitor automático de notificaciones electrónicas del Poder Judicial de la Nación (Argentina). Consulta el API interno del portal cada 30 minutos vía GitHub Actions y envía cada notificación nueva por Telegram con el PDF adjunto.

## Arquitectura

```
GitHub Actions (cron */30)
  └─ npm run check:now
       └─ Refresh OIDC contra sso.pjn.gov.ar (Keycloak realm pjn, client pjn-sne)
       └─ GET notif.pjn.gov.ar/api/notificaciones?bandeja=RECIBIDAS
       └─ Por cada id nuevo (PK en Supabase):
            ├─ GET notif.pjn.gov.ar/api/notificaciones/RECIBIDAS/{id}/pdf
            └─ Telegram sendDocument
```

Detalle de los endpoints y la decisión de migrar del scraper Playwright al API directo: [`REVERSE_ENGINEERING.md`](./REVERSE_ENGINEERING.md).

## Setup (una vez por máquina/repo)

1. Clonar y instalar:
   ```bash
   git clone <repo>
   cd pjn-notificaciones-monitor
   npm install
   npx playwright install chromium  # sólo se usa para el bootstrap
   ```

2. Crear proyecto en [Supabase](https://supabase.com) (free tier).

3. Aplicar migraciones (Supabase Studio → SQL Editor):
   ```bash
   # los .sql están en supabase/migrations/
   ```

4. `.env` local — copiar de `.env.example` y completar:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `TELEGRAM_BOT_TOKEN` (de @BotFather), `TELEGRAM_CHAT_ID`
   - Opcional: `PJN_USERNAME`, `PJN_PASSWORD` (sólo para auto-login en el bootstrap)

5. Capturar el refresh_token del PJN (login one-shot):
   ```bash
   npm run bootstrap:token
   ```
   Abre el browser, te logueás, y guarda el `refresh_token` en `kv_config` de Supabase.

6. Probar end-to-end:
   ```bash
   npm run check:now
   ```

## Deploy en GitHub Actions

Subir como **Repository secrets** (Settings → Secrets and variables → Actions):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `PJN_CLIENT_ID` = `pjn-sne`
- `PJN_REFRESH_TOKEN` (opcional; se rota a Supabase tras la primera corrida)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

El workflow `.github/workflows/monitor.yml` corre solo cada 30 min.

## Mantenimiento

- **Si el monitor falla con `Token is not active`**: la sesión Keycloak expiró. Correr `npm run bootstrap:token` y volver a probar.
- **Forzar reenvío de una notificación**: en Supabase, `update notificaciones_api set enviada=false where notificacion_id=<id>`.
- **Ver pendientes**: `select * from notificaciones_api where enviada=false`.

## Comandos

| Comando | Para qué |
|---|---|
| `npm run bootstrap:token` | Login one-shot, guarda refresh_token en Supabase |
| `npm run check:now` | Una corrida del monitor (idéntico a lo que hace GitHub Actions) |
| `npm run test:api-flow` | Smoke test: refresh + list + descarga 1 PDF a `data/pdfs/` |
| `npm run dev` / `monitor` | Loop continuo local con cron interno |
| `npm run build` | Compilar TS a `dist/` |

## Stack

Node 20, TypeScript, fetch nativo, Telegraf (Telegram), Supabase (Postgres), node-cron (sólo para el modo loop local). Playwright sólo se usa en `scripts/bootstrap-token.ts`.
