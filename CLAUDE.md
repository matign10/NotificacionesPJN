# PJN Notificaciones Monitor — contexto para Claude Code

Monitor automático del PJN. Corre en GitHub Actions cada 25 min y vigila dos cosas en paralelo, en una sola corrida:

1. **Notificaciones** (cédulas formales) en `notif.pjn.gov.ar`
2. **Entradas / eventos** (despachos, etc.) en `portalpjn.pjn.gov.ar`

Cada notificación o entrada nueva se manda por Telegram con su PDF y un header diferenciado.

## Arquitectura

- **Auth**: OIDC contra Keycloak (`sso.pjn.gov.ar`, realm `pjn`). Dos clients distintos, cada uno con su refresh_token. Los RT tienen TTL ~30 min, **rotan en cada uso** y se persisten en `kv_config`:
  - `pjn-sne` ↔ `kv_config.pjn_refresh_token_sne` (notificaciones)
  - `pjn-portal` ↔ `kv_config.pjn_refresh_token_portal` (entradas)
- **Notificaciones**:
  - `GET https://notif.pjn.gov.ar/api/notificaciones?bandeja=RECIBIDAS&fechaDesde=DDMMYYYY&fechaHasta=DDMMYYYY&page=N&pageSize=M`
  - `GET https://notif.pjn.gov.ar/api/notificaciones/RECIBIDAS/{id}/pdf`
- **Entradas / eventos**:
  - `GET https://api.pjn.gov.ar/eventos/?page=N&pageSize=M&categoria=judicial`
  - `GET https://api.pjn.gov.ar/eventos/{id}/pdf` (cuando `hasDocument=true`)
- **Storage**: Supabase Postgres.
  - `notificaciones_api` (PK `notificacion_id`)
  - `entradas_api` (PK `entrada_id`)
  - `kv_config` (refresh_tokens rotados)
- **Telegram**: Telegraf, dos formatos:
  - 🔔 `NUEVA NOTIFICACIÓN JUDICIAL` (PDF de la cédula)
  - 📥 `NUEVA ENTRADA` (PDF del despacho + link al SCW)

Documento técnico con todos los endpoints y la decisión arquitectónica: [`REVERSE_ENGINEERING.md`](./REVERSE_ENGINEERING.md).

## Estructura del código

```
src/
  pjn-api/
    types.ts              # types del shape del API
    keycloak.ts           # refresh OIDC con onRefresh callback
    notificaciones.ts     # list + getPdf (client pjn-sne)
    eventos.ts            # list + getPdf (client pjn-portal)
  monitor/
    api-monitor.ts        # orchestrador: refresh → list → insert → send → mark
  database/
    notificaciones-api-repo.ts   # repo Supabase
  telegram/
    telegram-bot.ts       # Telegraf wrapper
  config.ts               # env + winston logger
  check-now.ts            # entrypoint usado por GitHub Actions
  monitor.ts              # entrypoint con cron interno (loop local)
  index.ts                # alias de monitor.ts
  test-api-flow.ts        # smoke test e2e
scripts/
  bootstrap-token.ts      # login Playwright one-shot, guarda RT en Supabase
supabase/
  migrations/
    20260503_notificaciones_api.sql
    20260504_kv_config.sql
    20260505_entradas_api.sql
```

## Idempotencia y dedup

- `insertIfMissing(notif)` hace insert; si Postgres tira `23505` (unique violation por PK), lo trata como "ya existe, skip".
- `markSent(id)` se llama **después** del send a Telegram → at-least-once. Si Telegram envía OK pero el proceso muere antes del mark, la próxima corrida la reenvía.
- El estado de envío vive en la columna `enviada`; nunca se borran filas históricas.

## Variables de entorno

Ver `.env.example`. En CI van como GitHub Secrets/vars (workflow lee de `secrets.*`).

## Convenciones

- Sin emojis en código y en commits salvo que el usuario los pida.
- Spanish para los logs y mensajes al usuario; código en inglés cuando es código nuevo, mantener español si ya existía.
- Commits estilo "Sustantivo en español: descripción corta" siguiendo el log existente.
- No introducir dependencias nuevas sin necesidad clara — `fetch` nativo de Node 20+ alcanza para HTTP.

## Cómo testear

- `npm run test:api-flow` — refresh + list + descarga el primer PDF a `data/pdfs/`. No toca Supabase ni Telegram.
- `DISABLE_TELEGRAM=true npm run check:now` — corrida real contra Supabase pero sin spamear Telegram.
- `npm run check:now` — corrida real completa.

## Nota de operación

Si alguno de los dos refresh_tokens en `kv_config` (`pjn_refresh_token_sne`, `pjn_refresh_token_portal`) está caducado, la rama correspondiente falla con `Keycloak refresh failed (400): Token is not active`. Solución: `npm run bootstrap:token` (captura ambos en una sola sesión).

El cron está en `*/25` adrede: el RT tiene TTL 30 min y rota en cada uso; con `*/30` cualquier demora del runner deja la sesión muerta entre corridas.
