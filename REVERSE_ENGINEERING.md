# Reverse Engineering del Portal PJN — Notificaciones Electrónicas

**Fecha**: 2026-05-03
**Sesión**: captura en vivo vía Playwright MCP, usuario logueado con SSO real.
**Capturas crudas (sanitizadas)**: `data/reverse-eng/`

---

## TL;DR

El frontend de notificaciones electrónicas del PJN consume un **API REST JSON limpio y bien definido** sobre `notif.pjn.gov.ar/api/...`, autenticado con **Bearer JWT** emitido por Keycloak (SSO `sso.pjn.gov.ar`).

**Recomendación: reemplazar el scraper de DOM por un cliente HTTP que consuma el API directamente.** La superficie es chica (3 endpoints), el shape es estable y trae IDs únicos por notificación que sirven como clave de dedup natural — eliminando toda la heurística frágil de números/carátulas que tiene el scraper actual.

Se elimina la dependencia de Playwright en runtime (sólo se conserva, opcionalmente, para el flujo inicial de obtención del refresh_token).

---

## 1. Arquitectura observada

```
Usuario ──► sso.pjn.gov.ar (Keycloak realm "pjn", OIDC)
              │  emite access_token (Bearer JWT, ~5 min) + refresh_token
              ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ portalpjn.pjn.gov.ar  ──► api.pjn.gov.ar       (Entradas)   │
   │ notif.pjn.gov.ar     ──► notif.pjn.gov.ar/api  (Notif. e.)  │ ◄── lo que nos interesa
   │ scw.pjn.gov.ar       ──► /scw/...              (Expedientes)│
   └─────────────────────────────────────────────────────────────┘
```

- Cada subdominio tiene su propio `client_id` en Keycloak (`pjn-portal`, `pjn-sne`, `pjn-scw`, etc.).
- El SSO entrega tokens distintos para cada client (mismo `session_state`, distinta `azp`).
- El usuario tiene en su JWT el rol `pjn-sne: acceder` + `r:letradonotilex` → suficiente para listar y descargar notificaciones recibidas.
- **Hallazgo clave**: el scraper actual va al portal y al final navega a `notif.pjn.gov.ar` igual; el API que el frontend de esa app consume es directo y público (relativo a usuarios autenticados).

---

## 2. Endpoints descubiertos (lo que importa)

Todos requieren `Authorization: Bearer <access_token>` y devuelven CORS para el origin del frontend correspondiente.

### 2.1 Listar notificaciones recibidas — **PRINCIPAL**

```
GET https://notif.pjn.gov.ar/api/notificaciones
    ?bandeja=RECIBIDAS
    &fechaDesde=DDMMYYYY
    &fechaHasta=DDMMYYYY
    &page=0
    &pageSize=10
```

- **Auth**: `Bearer` con `azp=pjn-sne`.
- **Otros valores de `bandeja`** (no probados aún): `ENVIADAS`, `PENDIENTES` (existen menúitems en el DOM: "Bandeja de notificaciones enviadas", "Bandeja de mis notificaciones pendientes").
- **Formato de fechas**: `DDMMYYYY` sin separadores. Default observado: ventana de 2 meses.
- **Response shape** (real, sample en `data/reverse-eng/body-21-notificaciones-recibidas.json`):

```json
{
  "items": [
    {
      "id": 133534708,                      // ⭐ clave de dedup natural
      "expediente": {
        "id": 40254284,
        "camara": "Justicia Federal de La Plata",
        "numero": 24287,
        "anio": 2023,
        "caratula": "Legajo Nº 62 - IMPUTADO: ... s/LEGAJO DE APELACION",
        "numeracion": "FLP 24287/2023/62",
        "situacion": "N",
        "oficina": "CAMARA FEDERAL DE LA PLATA - SALA III",
        "reservado": 0
      },
      "destinatarios": [
        { "id": 20398297750, "tipo": "L", "tipoDescripcion": "Letrado",
          "nombre": "...", "cuit": "..." }
      ],
      "nombreAutor": "JUZGADO FEDERAL ...",
      "oficina": { "id": 5921, "idCamara": 18, "descripcion": "..." },
      "fecha": "2026-04-10T23:06:13.514-0300",
      "numeroCedula": 26000105604216,
      "origen": "J"
    }
  ],
  "hasNext": false,
  "numberOfItems": 6,
  "pageSize": 10,
  "page": 0
}
```

### 2.2 Descargar PDF de una notificación

```
GET https://notif.pjn.gov.ar/api/notificaciones/RECIBIDAS/{id}/pdf
```

- `{id}` = `items[].id` del listado.
- **Response**: `Content-Type: application/pdf; charset=UTF-8`, body binario.
- Headers de respuesta verificados: `cache-control: no-store`, `x-frame-options: DENY`.

### 2.3 Endpoints auxiliares (catálogos / contexto)

| Endpoint | Para qué |
|---|---|
| `GET notif.pjn.gov.ar/api/usuario/info` | Flags de capacidades del usuario (`puedeIngresar`, `tieneFirma`, etc.) |
| `GET notif.pjn.gov.ar/api/camaras` | Catálogo `[{id,codigo,descripcion}]` (CIV, COM, FLP, …) |
| `GET api.pjn.gov.ar/usuario/info-inicial` | Flags de UI (verificarEmail, etc.) |
| `GET api.pjn.gov.ar/usuario/apps` | Listado de apps habilitadas (Portal, SNE, SCW, DEOX…) |
| `GET api.pjn.gov.ar/eventos/?categoria=judicial&page=0&pageSize=20` | Lista de "Entradas" (despachos del SCW). **NO son notificaciones electrónicas** — fueron capturadas por error al inicio. |

### 2.4 Auth (Keycloak)

```
POST https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/token
GET  https://sso.pjn.gov.ar/auth/realms/pjn/.well-known/openid-configuration
```

Realm `pjn`, clients que nos interesan: `pjn-sne` (notificaciones), `pjn-portal` (portal). Token vive ~5 min (`exp - iat ≈ 300`); refresh por OIDC silent renew via iframe (`login-status-iframe.html`) — para un cliente headless basta usar `grant_type=refresh_token` contra el endpoint de token con el `refresh_token` guardado.

---

## 3. Selectores actuales (scraper) vs realidad

### Lo que asume `src/scraper/notification-scraper.ts`

El scraper hoy mezcla dos páginas en un mismo archivo:

1. **Navegar a "Notificaciones"** desde el portal: prueba ~22 selectores genéricos (`'#list-item-buttonNotificaciones'`, `'button:has-text("Notificaciones")'`, `'.tab:nth-child(2)'`, etc.) hasta encontrar uno que abra una nueva pestaña en `notif.pjn.gov.ar`. Frágil pero funciona porque uno de los primeros (`#list-item-buttonNotificaciones`) suele matchear.
2. **Detectar notificaciones en la página**: prueba ~14 selectores genéricos (`.notification`, `.notificacion`, `tbody tr`, `.card`, etc.), después una heurística de extracción por regex sobre `textContent` para obtener `numero` y `caratula`, asumiendo que **toda fila visible es una notificación** (`tieneNotificacion: true` hardcodeado, líneas 359-365). Si nada matchea, cae a `analizarContenidoGeneral` que parsea el `<body>` por líneas y regex de números de expediente.

Adicionalmente queda código muerto/legacy (`detectarExpedientesConNotificaciones`, `scrapingGenerico`, búsqueda del "círculo naranja" por colores RGB) que no se ejecuta en el flujo real pero ensucia el archivo (~860 líneas).

### Lo que realmente expone el DOM (capturado en `data/reverse-eng/snapshot-recibidas.md`)

La grilla de notificaciones es semánticamente accesible:

```yaml
grid "Listado de notificaciones" [ref=e116]:
  row "Notificación en expediente FLP 24287/2023/62, Tipo: Tribunal, Fecha: 10/04/2026":
    button "Botón Ver PDF de notificación"
    link   "Botón Abrir Expediente en la consulta web"
```

- Selectores reales que funcionan: `[role="grid"][aria-label="Listado de notificaciones"]` → `[role="row"]`. El `aria-label` de cada row contiene número de expediente, tipo y fecha en texto plano.
- Botón de PDF: `button[aria-label="Botón Ver PDF de notificación"]` (literal — typo "Botón" incluido).

### Diff resumido

| Aspecto | Scraper actual | Realidad |
|---|---|---|
| Identificador de notificación | regex sobre texto (`\d+/\d+`), genera IDs sintéticos `NOTIF-<ts>-<i>` cuando falla | `id` numérico estable del API (e.g. `133534708`) |
| Carátula | substring de `textContent` con `replace`/`trim` | `expediente.caratula` exacto |
| Número de expediente | regex sobre texto | `expediente.numeracion` (`"FLP 24287/2023/62"`) |
| Fecha | no se captura | `fecha` ISO con TZ |
| "Tiene notificación?" | hardcoded `true` para toda fila visible | implícito (todo en `bandeja=RECIBIDAS` es notificación) |
| Detección de "círculo naranja" | búsqueda de colores RGB sobre estilos computados | **no existe en esta página** — es de otra vista (Entradas/eventos del portal) |
| Paginación | no hay | `hasNext`/`page`/`pageSize` del API |

---

## 4. Análisis: ¿reemplazo o mejora?

### Pros de ir por el API

1. **Identidad estable**: `items[].id` elimina el problema de duplicados que motivó el último merge. Hoy en Supabase la PK efectiva es `numero` extraído por regex; con el API sería el `id` real del PJN.
2. **~90% menos código y dependencias**: chau Playwright en runtime, chau Chromium en GitHub Actions (ahorra ~150 MB de cache + tiempo de cold start), chau xvfb/headless config.
3. **Más rápido**: una sola request HTTP vs. login SSO + navegación + render + DOM scrape (típicamente 30–90 s → ~2 s).
4. **Datos más ricos**: `fecha`, `numeroCedula`, `nombreAutor`, `oficina`, `idCamara` — hoy se pierden.
5. **Robustez**: ya no hay 22 selectores en cascada con `try/catch`; el shape es contractual.
6. **CI más barato**: el GitHub Action puede ser una Lambda-style función Node sin browser, posiblemente cabiendo en el free tier de minutos con margen.

### Contras / riesgos

1. **API "interna"**: no está documentada públicamente. El PJN puede cambiarla sin aviso. Mitigación: el scraper de DOM también es frágil a cambios de UI; en la práctica el riesgo es comparable y los breaks de un API REST suelen ser más fáciles de fixear (cambiar un nombre de campo) que reescribir selectores.
2. **Términos de uso**: el portal del PJN no expone TOS técnicos visibles para el acceso programático, pero tampoco es público. Estamos automatizando acciones del propio usuario sobre sus propias notificaciones, con sus credenciales — equivalente legal/ético al scraper actual. **Vale confirmar internamente, pero no es un riesgo nuevo introducido por este cambio.**
3. **Manejo de refresh token**: hoy Playwright + cookies persistentes "simplemente funcionan". En modo API hay que implementar refresh OIDC explícito (`grant_type=refresh_token`) y persistir `refresh_token` cifrado. Es ~30 líneas de código pero hay que hacerlo bien.
4. **MFA/captcha**: si el PJN agrega MFA al login (no observamos hoy), el flujo headless rompe igual que el scraper actual. El refresh_token sobrevive a MFA hasta que expira la sesión Keycloak (típicamente días/semanas), así que el impacto es bajo si el bootstrap se hace manualmente una vez.
5. **Origin/CORS**: el API impone `Access-Control-Allow-Origin: https://notif.pjn.gov.ar` para el browser, pero CORS no aplica en server-to-server. Sin embargo, podría haber checks adicionales de `Origin`/`Referer`. Mitigación: setear ambos headers a los del frontend real al hacer las requests.

### Puntos a confirmar antes de implementar

- ¿Hay rate limiting? No se observó; tiramos ~10 requests sin throttle.
- ¿`bandeja=PENDIENTES` y `=ENVIADAS` tienen el mismo shape? (probable, pero no probado).
- ¿El refresh_token de `pjn-sne` se obtiene directo o requiere ir vía `pjn-portal`? El frontend de notif obtiene el suyo por silent SSO, así que con el refresh_token de cualquier client del realm probablemente alcanza.

---

## 5. Propuesta de arquitectura nueva

```
┌───────────────────────────────────────────┐
│ src/                                      │
│   auth/                                   │
│     keycloak-client.ts   ← refresh OIDC   │
│   pjn-api/                                │
│     client.ts           ← fetch + Bearer  │
│     notificaciones.ts   ← list/getPdf     │
│     types.ts            ← tipos del API   │
│   monitor.ts            ← compara, encola │
│   telegram/             ← (sin cambios)   │
│   database/             ← (sin cambios,   │
│                            cambia PK a    │
│                            notificacion_id│
│                            del API)       │
│ scripts/                                  │
│   bootstrap-token.ts    ← login one-shot  │
│                            con Playwright │
│                            y guarda RT    │
└───────────────────────────────────────────┘
```

**Bootstrap manual (una vez)**: `npm run bootstrap` abre Playwright headed, el usuario se loguea, el script extrae `refresh_token` de `sessionStorage` y lo guarda cifrado (en GitHub Secrets para CI, en `.env.local` para dev). Mientras Keycloak no invalide la sesión (típicamente vida larga si "remember me"), el monitor corre headless indefinidamente.

**Loop del monitor (cada 30 min)**:
1. `keycloak.refreshAccessToken()` → access_token fresco.
2. `notificaciones.list({ bandeja: 'RECIBIDAS', fechaDesde: hoy-N, fechaHasta: hoy })`.
3. Por cada `item.id` no visto en DB → `notificaciones.getPdf(id)` → guardar + Telegram → marcar enviado.
4. Si `getPdf` o `list` devuelven 401, intentar refresh y reintentar una vez; si falla de nuevo, mandar alerta a Telegram con "se necesita re-bootstrap".

**Migración de DB**: agregar columna `notificacion_id BIGINT UNIQUE` a la tabla, backfill desde lo que se pueda, y deprecar la lógica de match por `numero/caratula`.

---

## 6. Riesgos a explicitar antes de codear

1. **El refresh_token del access_token expirado (`exp` ya pasó cuando escribo esto) ya no sirve para probar fuera del browser**. Para validar el approach end-to-end sin browser hace falta una sesión fresca.
2. **Si el PJN agrega protección anti-bot tipo Akamai/Cloudflare BMP** en `notif.pjn.gov.ar/api/*`, el cliente HTTP rompería antes que el scraper. No hay señales de eso hoy (sólo la cookie F5 `TS017024bd`, tipo session, que se obtiene en el primer GET).
3. **El archivo `data/reverse-eng/req-22-pdf-notif-headers.txt` y compañía contienen el Bearer JWT y PII tuya** — fueron sanitizados (CUIL, email, nombre y tokens reemplazados por `<REDACTED_*>`), pero conviene que los revises antes de cualquier commit. Mejor todavía: agregar `data/reverse-eng/` al `.gitignore` (no está hoy).

---

## 7. Recomendación

**Ir por el API**. El esfuerzo es chico (~200 líneas netas, contando cliente OIDC + cliente notif + tipos), el código resultante es dramáticamente más simple y robusto que el scraper de 860 líneas, y resuelve estructuralmente el bug de duplicados que motivó el último merge (al usar `id` real en lugar de heurística sobre texto).

**Plan sugerido si avanzamos**:
1. Validar manualmente con `curl` (o un script de prueba mínimo) los 3 endpoints usando un token fresco — confirmar shape y que `bandeja=PENDIENTES` se comporta igual.
2. Probar `grant_type=refresh_token` contra Keycloak para confirmar que el refresh funciona server-to-server.
3. Implementar el cliente nuevo en una rama, dejando el scraper actual en paralelo detrás de un feature flag `MONITOR_MODE=api|scraper`.
4. Correr ambos en paralelo durante una semana en CI, comparar resultados (alertas Telegram diferenciadas), y promover el API una vez que se vea que detecta lo mismo (o mejor) sin falsos positivos.
5. Borrar el scraper.

Quedo esperando luz verde para empezar — o course correction si ves algo que no encaja con cómo querés evolucionar el sistema.
