# PJN Notificaciones Monitor — contexto para Claude Code

Monitor automático de notificaciones electrónicas del Poder Judicial de la Nación (Argentina). Corre en GitHub Actions cada 30 min, consume el API interno del portal y manda cada notificación nueva por Telegram con su PDF.

## Arquitectura

- **Auth**: OIDC contra Keycloak (`sso.pjn.gov.ar`, realm `pjn`, client `pjn-sne`). Refresh token con TTL ~30 min, **rota en cada uso** y se persiste en `kv_config` de Supabase.
- **Lista**: `GET https://notif.pjn.gov.ar/api/notificaciones?bandeja=RECIBIDAS&fechaDesde=DDMMYYYY&fechaHasta=DDMMYYYY&page=N&pageSize=M`
- **PDF**: `GET https://notif.pjn.gov.ar/api/notificaciones/RECIBIDAS/{id}/pdf` → bytes binarios
- **Storage**: Supabase Postgres. Tabla `notificaciones_api` con PK = `notificacion_id` (id estable que viene del API). Tabla `kv_config` para persistir el refresh_token rotado.
- **Notificación**: Telegram via Telegraf (`bot.telegram.sendDocument` con buffer del PDF).

Documento técnico con todos los endpoints y la decisión arquitectónica: [`REVERSE_ENGINEERING.md`](./REVERSE_ENGINEERING.md).

## Estructura del código

```
src/
  pjn-api/
    types.ts              # types del shape del API
    keycloak.ts           # refresh OIDC con onRefresh callback
    notificaciones.ts     # list + getPdf
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

Si en Supabase `kv_config.pjn_refresh_token` falta o está desactualizado y la sesión Keycloak expiró, el monitor falla con `Keycloak refresh failed (400): Token is not active`. Solución: `npm run bootstrap:token`.
