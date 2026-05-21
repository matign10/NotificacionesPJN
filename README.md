# PJN Notificaciones Monitor

Monitor automático del Poder Judicial de la Nación (Argentina). Corre en GitHub Actions cada 25 minutos y, en una sola corrida, vigila dos cosas para **uno o varios usuarios PJN**, cada uno con su propio bot de Telegram:

1. **Notificaciones electrónicas** (cédulas) en `notif.pjn.gov.ar`
2. **Entradas / eventos** (despachos del SCW) en `api.pjn.gov.ar/eventos`

Cada notificación o entrada nueva se manda por Telegram con su PDF adjunto y un header diferenciado.

## Arquitectura

```
GitHub Actions (cron */25)
  └─ npm run check:now
       └─ Por cada usuario en PJN_USERS:
            ├─ Refresh OIDC contra sso.pjn.gov.ar (Keycloak realm pjn)
            │    ├─ client pjn-sne    → notificaciones
            │    └─ client pjn-portal → entradas/eventos
            ├─ Notificaciones: GET notif.pjn.gov.ar/api/notificaciones?bandeja=RECIBIDAS
            │    └─ por id nuevo → GET .../{id}/pdf → Telegram (bot del usuario)
            └─ Entradas: GET api.pjn.gov.ar/eventos/?categoria=judicial
                 └─ por id nuevo → GET .../{id}/pdf (si hasDocument) → Telegram
```

- **Modo API, no scraping**: se consume directamente el API REST interno que usa el frontend del PJN. El `id` estable de cada notificación/entrada es la clave de dedup natural. (Migración del scraper Playwright documentada en [`REVERSE_ENGINEERING.md`](./REVERSE_ENGINEERING.md).)
- **Auth**: OIDC contra Keycloak. Cada client tiene su propio `refresh_token`, con TTL ~30 min, que **rota en cada uso** y se persiste en `kv_config` namespaceado por usuario:
  - `pjn_refresh_token_sne_<userId>` (notificaciones)
  - `pjn_refresh_token_portal_<userId>` (entradas)
- **Storage**: Supabase Postgres, multi-tenant (columna `user_id`).
  - `notificaciones_api` (PK `(user_id, notificacion_id)`)
  - `entradas_api` (PK `(user_id, entrada_id)`)
  - `kv_config` (refresh_tokens rotados + flags internos)
- **Telegram**: Telegraf. Un bot por usuario. Dos formatos: 🔔 `NUEVA NOTIFICACIÓN JUDICIAL` y 📥 `NUEVA ENTRADA`.
- **Auto-recovery**: si la sesión Keycloak de un usuario muere (`Token is not active`), se dispara un bootstrap headless con Playwright usando sus credenciales, reintenta una vez, y si falla manda **una** alerta por Telegram cada 6h.

## Configuración multi-usuario

El monitor lee el secret/env `PJN_USERS`: un JSON array donde cada usuario tiene su propio bot de Telegram.

```json
[
  {
    "id": "matias",
    "pjnUsername": "20xxxxxxxxx",
    "pjnPassword": "...",
    "telegramBotToken": "123456:ABC...",
    "telegramChatId": "111111"
  },
  {
    "id": "user2",
    "pjnUsername": "27xxxxxxxxx",
    "pjnPassword": "...",
    "telegramBotToken": "654321:DEF...",
    "telegramChatId": "222222"
  }
]
```

- `id`: discriminador (columna `user_id` en la base y sufijo en `kv_config`). No lo cambies una vez en uso.
- `pjnUsername` / `pjnPassword`: opcionales, sólo para el auto-login del bootstrap.
- Si **no** definís `PJN_USERS`, el monitor arma un solo usuario (id `matias` por default) desde las vars legacy `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + `PJN_USERNAME`/`PJN_PASSWORD`.

## Setup (una vez)

1. Clonar e instalar:
   ```bash
   git clone <repo>
   cd pjn-notificaciones-monitor
   npm install
   npx playwright install chromium   # sólo para el bootstrap / auto-recovery
   ```

2. Crear proyecto en [Supabase](https://supabase.com) (free tier).

3. Aplicar **todas** las migraciones (Supabase Studio → SQL Editor), en orden:
   ```
   supabase/migrations/20260503_notificaciones_api.sql
   supabase/migrations/20260504_kv_config.sql
   supabase/migrations/20260505_entradas_api.sql
   supabase/migrations/20260506_security_hardening.sql   # habilita RLS
   supabase/migrations/20260507_multi_tenant.sql         # columna user_id + PK compuesta
   ```

4. `.env` local — copiar de `.env.example` y completar:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (service_role: el backend bypassea RLS)
   - `PJN_USERS` (JSON) **o** las vars legacy de un solo usuario
   - Crear un bot por usuario con [@BotFather](https://t.me/BotFather); el chat id sale de `GET https://api.telegram.org/bot<TOKEN>/getUpdates`

5. Sembrar los refresh_tokens (login one-shot, captura los 2 clients por usuario):
   ```bash
   npm run bootstrap:token
   ```
   Abre el navegador, te logueás con cada usuario, y guarda los `refresh_token` en `kv_config`.

6. Probar end-to-end:
   ```bash
   npm run check:now
   ```

## Deploy en GitHub Actions

**Repository secrets** (Settings → Secrets and variables → Actions):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `PJN_USERS` (JSON array) — o las vars legacy para un solo usuario
- (opcional, modo legacy) `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PJN_USERNAME`, `PJN_PASSWORD`

El workflow `.github/workflows/monitor.yml` corre solo cada 25 min. El cron está a `*/25` adrede: el RT tiene TTL 30 min y rota en cada uso; con `*/30` cualquier demora del runner deja la sesión muerta entre corridas.

## Seguridad

- **Service_role key, no anon**: el monitor corre server-side. Las 3 tablas tienen RLS habilitada sin policies → anon/authenticated quedan bloqueados; sólo el backend con service_role entra.
- **Nunca** commitear credenciales. Van en GitHub Secrets (CI) o `.env` local (gitignored). El historial de git es para siempre: si se filtró algo, rotalo.

## Mantenimiento / Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| `Keycloak refresh failed (400): Token is not active` | El refresh_token de ese usuario expiró/rotó sin persistir. | El auto-recovery intenta re-bootstrap solo. Si falla (captcha/MFA/clave cambiada), corré `npm run bootstrap:token` y completá el captcha en el navegador. |
| `Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY` | Falta el secret o quedó con nombre viejo. | Verificar el secret en GitHub (debe llamarse `SUPABASE_SERVICE_ROLE_KEY`). |
| `relation "..." does not exist` | Migración sin aplicar. | Correr las migraciones pendientes en Supabase. |
| Warnings de Security Advisor (RLS) | Tabla sin RLS o sin policies. | Aplicar `20260506_security_hardening.sql`. |
| Forzar reenvío de una notificación | — | `update notificaciones_api set enviada=false where user_id='<id>' and notificacion_id=<id>` |
| Ver pendientes de un usuario | — | `select * from notificaciones_api where user_id='<id>' and enviada=false` |

## Comandos

| Comando | Para qué |
|---|---|
| `npm run bootstrap:token` | Login one-shot por usuario, guarda refresh_tokens en Supabase |
| `npm run check:now` | Una corrida completa (lo que hace GitHub Actions), todos los usuarios |
| `npm run test:api-flow` | Smoke test: refresh + list + descarga 1 PDF a `data/pdfs/` |
| `npm run dev` / `monitor` | Loop continuo local con cron interno |
| `npm run build` | Compilar TS a `dist/` |

## Historial de decisiones y bugs resueltos

- **Duplicados de notificaciones** (origen del primer fix): el scraper viejo generaba IDs sintéticos por regex sobre texto y reenviaba lo ya enviado. Se corrigió la lógica invertida y luego se eliminó de raíz migrando al `id` real del API.
- **Migración scraper → API interno**: se reemplazaron ~860 líneas de scraping Playwright frágil por un cliente HTTP de ~200 líneas. Más rápido, más robusto, dedup natural por `id`. Ver `REVERSE_ENGINEERING.md`.
- **Refresh_token rotativo**: Keycloak rota el RT en cada uso (TTL 30 min). Sin persistencia entre procesos, la 2ª corrida fallaba. Se agregó `kv_config` + callback `onRefresh`.
- **Entradas/eventos**: se sumó el monitoreo de despachos del SCW (`api.pjn.gov.ar/eventos`) en paralelo a las notificaciones, con su propio client (`pjn-portal`) y refresh_token.
- **Auto-recovery de sesión muerta**: re-bootstrap headless automático + alerta por Telegram con cooldown de 6h.
- **Hardening de seguridad**: migración de anon key → service_role key y RLS habilitada en las 3 tablas.
- **Multi-tenant**: columna `user_id`, PK compuestas, `kv_config` namespaceado, un bot de Telegram por usuario. Sumar un usuario nuevo = agregar una entrada a `PJN_USERS`, cero código.
- **CI**: cron `*/25`, Node 20 → actions `@v5` (soporte Node 24).

## Stack

Node 20, TypeScript, `fetch` nativo, Telegraf (Telegram), Supabase (Postgres), node-cron (modo loop local). Playwright sólo en el bootstrap/auto-recovery.
