# PJN Notificaciones Monitor — contexto para Claude Code

Monitor automático del PJN. Corre en GitHub Actions cada 25 min y vigila dos cosas en paralelo, en una sola corrida:

1. **Notificaciones** (cédulas formales) en `notif.pjn.gov.ar`
2. **Entradas / eventos** (despachos, etc.) en `portalpjn.pjn.gov.ar`

Cada notificación o entrada nueva se manda por Telegram con su PDF y un header diferenciado.

## Arquitectura

- **Multi-usuario**: el monitor procesa N usuarios PJN (uno o varios), cada uno con su propio bot de Telegram. Se configuran en el env/secret `PJN_USERS` (JSON array). El loader vive en `src/users.ts` (con fallback a un solo usuario `matias` desde vars legacy). Cada usuario se procesa aislado en su try/catch: si uno falla, los demás siguen.
- **Auth**: OIDC contra Keycloak (`sso.pjn.gov.ar`, realm `pjn`). Dos clients distintos, cada uno con su refresh_token. Los RT tienen TTL ~30 min, **rotan en cada uso** y se persisten en `kv_config` namespaceados por usuario:
  - `pjn-sne` ↔ `kv_config.pjn_refresh_token_sne_<userId>` (notificaciones)
  - `pjn-portal` ↔ `kv_config.pjn_refresh_token_portal_<userId>` (entradas)
  - helpers de keys: `rtKeySne(id)`, `rtKeyPortal(id)`, `alertKey(id)` en `src/users.ts`
- **Notificaciones**:
  - `GET https://notif.pjn.gov.ar/api/notificaciones?bandeja=RECIBIDAS&fechaDesde=DDMMYYYY&fechaHasta=DDMMYYYY&page=N&pageSize=M`
  - `GET https://notif.pjn.gov.ar/api/notificaciones/RECIBIDAS/{id}/pdf`
- **Entradas / eventos**:
  - `GET https://api.pjn.gov.ar/eventos/?page=N&pageSize=M&categoria=judicial`
  - `GET https://api.pjn.gov.ar/eventos/{id}/pdf` (cuando `hasDocument=true`)
- **Storage**: Supabase Postgres, multi-tenant (columna `user_id`). Acceso con **service_role key** (bypassea RLS; las 3 tablas tienen RLS habilitada sin policies).
  - `notificaciones_api` (PK `(user_id, notificacion_id)`)
  - `entradas_api` (PK `(user_id, entrada_id)`)
  - `kv_config` (refresh_tokens rotados + flags, keys namespaceadas por usuario)
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
  bootstrap/
    auto-bootstrap.ts     # captura RT vía Playwright (CLI + auto-recovery), por usuario
  monitor/
    api-monitor.ts        # orchestrador por usuario: refresh → list → insert → send → mark
  database/
    notificaciones-api-repo.ts   # repo Supabase (filtra por user_id)
  telegram/
    telegram-bot.ts       # Telegraf wrapper (config por constructor: token+chatId)
  users.ts                # loadUsers() + helpers de keys namespaceadas
  config.ts               # env + winston logger
  check-now.ts            # entrypoint CI: itera usuarios, auto-recovery, alerta
  monitor.ts              # entrypoint con cron interno (loop local, multi-usuario)
  index.ts                # alias de monitor.ts
  test-api-flow.ts        # smoke test e2e
scripts/
  bootstrap-token.ts      # login Playwright one-shot por usuario, guarda RT en Supabase
supabase/
  migrations/
    20260503_notificaciones_api.sql
    20260504_kv_config.sql
    20260505_entradas_api.sql
    20260506_security_hardening.sql   # RLS on en las 3 tablas
    20260507_multi_tenant.sql         # user_id + PK compuesta + rename de keys
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

Si alguno de los refresh_tokens en `kv_config` (`pjn_refresh_token_sne_<id>`, `pjn_refresh_token_portal_<id>`) está caducado, ese flujo falla con `Keycloak refresh failed (400): Token is not active`. El auto-recovery intenta re-bootstrap headless solo; si no puede (captcha/MFA/clave cambiada), manda una alerta por Telegram cada 6h. Solución manual: `npm run bootstrap:token`.

El cron está en `*/25` adrede: el RT tiene TTL 30 min y rota en cada uso; con `*/30` cualquier demora del runner deja la sesión muerta entre corridas.
