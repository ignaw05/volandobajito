# Plan de Implementación — Motor de Deals de Vuelos desde Argentina

> **Documento para Claude Code.** Ejecutar una fase por sesión, en orden. No avanzar de fase sin cumplir los criterios de aceptación. No construir nada listado en "Fuera de alcance".

---

## 1. Contexto y objetivo

Sistema que detecta precios anómalamente bajos de vuelos con salida desde aeropuertos argentinos, los verifica en tiempo real, y los publica (con curaduría humana) en un canal de Telegram. Modelo de negocio futuro: freemium por velocidad de alerta. **Fase actual: validación — canal gratuito.**

**Principio rector:** la confianza es el producto. Nunca se publica un precio sin verificación en tiempo real. Ante la duda, no se publica.

**Pipeline conceptual (embudo de 3 capas):**

```
Capa 1: Barrido masivo (Travelpayouts Data API, caché, gratis)
   ~500 rutas × 2-3 corridas/día → escribe price_history
        ↓
Capa 2: Detección estadística (Postgres, propio)
   precio < p10 de 90 días Y precio < 70% de mediana → candidato
        ↓
Capa 3: Verificación real-time (API paga, solo candidatos: 5-20/corrida)
   precio confirmado → cola de curaduría
        ↓
Curaduría humana (bot privado Telegram: Aprobar/Rechazar)
        ↓
Publicación (canal público Telegram, precio en USD + ARS dólar tarjeta,
   link con tracking de clicks)
```

---

## 2. Stack (decisiones fijas — no proponer alternativas)

| Componente | Tecnología |
|---|---|
| Lenguaje | TypeScript (Node 20+), ESM |
| Base de datos | Supabase (Postgres) — cliente `@supabase/supabase-js`, migraciones SQL planas |
| Worker / cron | GitHub Actions (workflow programado) |
| Barrido (capa 1) | Travelpayouts Data API v3 (`prices_for_dates`) |
| Verificación (capa 3) | SearchApi.io `google_flights` (alternativa configurable: FlightAPI.io) |
| Cotización dólar | dolarapi.com (`/v1/dolares/tarjeta`) — gratis, sin auth |
| Bots Telegram | `grammy` (bot de curaduría privado + publicación en canal) |
| Redirect/tracking | Vercel serverless function (única pieza desplegada en Vercel) |
| Tests | `vitest` |
| Lint/format | `biome` |

**Reglas de código:**
- Identificadores, comentarios y commits en inglés. Mensajes de cara al usuario final (posts de Telegram) en español rioplatense.
- Todos los clientes de APIs externas viven en `src/clients/` detrás de una interfaz propia (para poder swapear proveedor de capa 3 sin tocar lógica).
- Toda llamada externa: timeout explícito, retry con backoff (máx 3), y respeto de headers de rate limit cuando existan.
- Sin frameworks pesados. Sin ORM (SQL directo vía supabase-js / `postgres.js`). Sin clases donde una función alcanza.
- Variables de entorno validadas al arranque con `zod` (`src/config.ts`). Si falta una, el proceso muere con mensaje claro.

---

## 3. Estructura del repositorio

```
flight-deals/
├── .github/workflows/
│   ├── scan.yml              # cron cada 8h: pipeline completo
│   └── recheck.yml           # cron cada 12h: re-verificación de deals publicados
├── migrations/
│   ├── 001_initial_schema.sql
│   └── 002_route_seed.sql
├── src/
│   ├── config.ts             # env validation (zod)
│   ├── clients/
│   │   ├── travelpayouts.ts  # capa 1
│   │   ├── flightVerifier.ts # interfaz capa 3 + impl SearchApi
│   │   ├── dolar.ts          # dolarapi.com
│   │   └── telegram.ts       # wrapper grammy
│   ├── pipeline/
│   │   ├── scan.ts           # capa 1: barrido → price_history
│   │   ├── detect.ts         # capa 2: stats + candidatos
│   │   ├── verify.ts         # capa 3: confirmación
│   │   ├── recheck.ts        # higiene de deals publicados
│   │   └── run.ts            # orquestador (entrypoint del cron)
│   ├── curation/
│   │   └── bot.ts            # bot privado con botones inline
│   ├── publish/
│   │   ├── format.ts         # armado del post (puro, testeable)
│   │   └── publish.ts        # envío al canal
│   └── db/
│       └── queries.ts        # todas las queries SQL centralizadas
├── api/                      # Vercel functions
│   └── go/[dealId].ts        # redirect con tracking
├── scripts/
│   ├── seed-routes.ts
│   └── bootstrap-baseline.ts # opcional, ver Fase 2
├── tests/
├── .env.example
└── README.md
```

---

## 4. Fases de implementación

### Fase 0 — Setup del proyecto

**Tareas:**
1. Inicializar repo: `package.json` (ESM, Node 20), TypeScript estricto, biome, vitest.
2. `src/config.ts` con schema zod de todas las env vars (ver §7) y carga fail-fast.
3. `.env.example` completo con comentarios.
4. README con: descripción de una línea, cómo correr migraciones, cómo correr cada comando del pipeline localmente (`npm run scan`, `npm run detect`, etc.).

**Criterios de aceptación:**
- `npm run typecheck`, `npm run lint` y `npm test` pasan (con al menos 1 test trivial de config).
- Ejecutar cualquier script sin env vars muere con error legible que nombra la variable faltante.

---

### Fase 1 — Schema de base de datos

Crear `migrations/001_initial_schema.sql` con exactamente este modelo (ajustar detalles de sintaxis si hace falta, no el diseño):

```sql
-- Rutas del universo monitoreado
create table routes (
  id            serial primary key,
  origin        text not null,            -- IATA: EZE, AEP, COR, MDZ, ROS
  destination   text not null,            -- IATA
  region        text not null,            -- 'regional' | 'caribbean' | 'usa' | 'europe' | 'other'
  active        boolean not null default true,
  -- umbral absoluto de cordura en USD: precio bajo este valor es candidato
  -- siempre, sin importar la estadística. NULL = sin umbral absoluto.
  sanity_threshold_usd numeric,
  created_at    timestamptz not null default now(),
  unique (origin, destination)
);

-- Cada observación de precio (capa 1 y capa 3 escriben acá)
create table price_history (
  id            bigserial primary key,
  route_id      int not null references routes(id),
  depart_date   date not null,
  return_date   date,                     -- null = one-way
  price_usd     numeric not null,
  airline       text,
  direct        boolean,
  source        text not null,            -- 'travelpayouts' | 'searchapi' | 'flightapi'
  observed_at   timestamptz not null default now()
);
create index idx_price_history_route_time on price_history (route_id, observed_at desc);

-- Stats rodantes por ruta (refrescadas en cada corrida de detect)
create table route_stats (
  route_id      int primary key references routes(id),
  median_usd    numeric,
  p10_usd       numeric,
  p25_usd       numeric,
  sample_count  int not null default 0,
  window_days   int not null default 90,
  updated_at    timestamptz not null default now()
);

-- Ciclo de vida del deal
create type deal_status as enum
  ('candidate', 'verified', 'rejected', 'published', 'expired');

create table deals (
  id            uuid primary key default gen_random_uuid(),
  route_id      int not null references routes(id),
  status        deal_status not null default 'candidate',
  depart_date   date not null,
  return_date   date,
  cached_price_usd    numeric not null,   -- precio que disparó la detección (capa 1)
  verified_price_usd  numeric,            -- precio confirmado (capa 3)
  airline       text,
  direct        boolean,
  booking_url   text,                     -- link a Google Flights con la búsqueda armada
  -- contexto estadístico congelado al momento de la detección:
  median_at_detection numeric,
  discount_pct  numeric,                  -- 1 - (price / median)
  score         numeric,                  -- ver fórmula en Fase 3
  is_error_fare boolean not null default false,
  detected_at   timestamptz not null default now(),
  verified_at   timestamptz,
  published_at  timestamptz,
  expired_at    timestamptz,
  telegram_message_id bigint,             -- para editar el post al expirar
  rejection_reason text
);
create index idx_deals_status on deals (status);
-- cooldown: evita duplicados de la misma ruta en ventana corta
create index idx_deals_route_detected on deals (route_id, detected_at desc);

-- Tracking de clicks (lo escribe la Vercel function)
create table click_events (
  id          bigserial primary key,
  deal_id     uuid not null references deals(id),
  clicked_at  timestamptz not null default now(),
  user_agent  text,
  referer     text
);
create index idx_clicks_deal on click_events (deal_id);
```

`migrations/002_route_seed.sql` + `scripts/seed-routes.ts`: poblar ~400-500 rutas. Orígenes: EZE, AEP, COR, MDZ, ROS. Destinos por región (lista mínima a expandir): GRU, GIG, FLN, SSA, REC, SCL, MVD, PDP, ASU, LIM, BOG, CUN, PUJ, HAV, MIA, MCO, JFK, LAX, MAD, BCN, FCO, MXP, CDG, LIS, AMS, LHR, TLV, AKL... Asignar `sanity_threshold_usd` por región: regional 120, caribbean 450, usa 550, europe 650.

**Criterios de aceptación:**
- Migraciones corren limpias en Supabase desde cero.
- Seed deja ≥ 400 rutas activas, sin duplicados.
- `db/queries.ts` expone funciones tipadas para cada operación que usarán las fases siguientes (insert price, upsert stats, crear/transicionar deal, registrar click). Tests unitarios de las queries contra una instancia local de Postgres o mocks finos.

---

### Fase 2 — Capa 1: scanner (Travelpayouts)

**Cliente** (`src/clients/travelpayouts.ts`):
- Endpoint: `GET https://api.travelpayouts.com/aviasales/v3/prices_for_dates`
- Params: `origin`, `destination`, `departure_at` (YYYY-MM), `currency=usd`, `one_way=false`, `limit=30`, `token` (header `X-Access-Token` o param `token`).
- Consultar por **mes**: para cada ruta, los próximos 4 meses (4 requests por ruta).
- Rate limit: este endpoint admite ~600 req/min. Implementar un limitador conservador a **300 req/min** y leer headers `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` si están presentes; al recibir 429, dormir hasta el reset.

**Pipeline** (`src/pipeline/scan.ts`):
1. Leer rutas activas.
2. Para cada ruta × mes: pedir precios, insertar cada resultado en `price_history` (source `travelpayouts`).
3. Manejar respuestas vacías sin error (rutas poco buscadas pueden no tener caché — es esperado, loguear y seguir).
4. Resumen al final por stdout: rutas barridas, observaciones insertadas, errores, duración.

**Nota importante sobre los datos:** los precios de esta API vienen de la **caché de búsquedas de usuarios de Aviasales (hasta 7 días de antigüedad)**. No son precios en vivo. Por eso esta capa solo detecta candidatos; jamás publica.

**Opcional** (`scripts/bootstrap-baseline.ts`): si `SERPAPI_KEY` está configurada, para las 60 rutas principales hacer 1 llamada a SerpApi Google Flights y guardar `typical_price_range` como observaciones sintéticas marcadas `source='serpapi_bootstrap'`, para mitigar el arranque en frío del baseline. Si no hay key, omitir sin fallar.

**Criterios de aceptación:**
- Corrida completa de ~500 rutas × 4 meses termina sin agotar rate limits (verificado con el limitador).
- Respuestas vacías y errores HTTP no abortan la corrida (aislamiento por ruta).
- Test unitario del parser de respuesta con fixture JSON real del endpoint.
- Idempotencia razonable: correr dos veces seguidas duplica observaciones (aceptable, son lecturas en el tiempo) pero no rompe nada.

---

### Fase 3 — Capa 2: detección estadística

**`src/pipeline/detect.ts`:**

1. **Refrescar `route_stats`**: por ruta, sobre `price_history` de los últimos 90 días, calcular mediana, p10, p25 y sample_count (usar `percentile_cont` en SQL, no en JS).
2. **Regla de candidato** (un precio reciente — última corrida de scan — es candidato si):
   - `sample_count >= 25` (sin muestra suficiente no hay estadística confiable), **y**
   - `price < p10` **y** `price < 0.70 × mediana`, **o**
   - `price < sanity_threshold_usd` de la ruta (si está definido).
3. **Error fare**: `price < 0.50 × mediana` → `is_error_fare = true` (prioridad máxima en la cola).
4. **Cooldown**: si existe un deal de la misma ruta con `detected_at` en las últimas 72 h y estado distinto de `rejected`, no crear otro.
5. **Score** (para ordenar la curaduría):
   `score = discount_pct × 100 + (direct ? 10 : 0) + region_weight + breadth_bonus`
   donde `region_weight`: europe 15, usa 12, caribbean 10, regional 5; `breadth_bonus`: +10 si hay ≥ 5 fechas distintas de la misma ruta bajo el umbral en esta corrida (señal de deal amplio, no glitch de una fecha).
6. Insertar candidatos en `deals` con status `candidate` y el contexto estadístico congelado.

**Modo silencioso:** si la env var `SILENT_MODE=true`, el pipeline corre scan+detect pero `verify` y toda notificación quedan deshabilitados. **Las primeras 1-2 semanas de producción corren así** para acumular baseline.

**Criterios de aceptación:**
- Tests unitarios de la regla de detección con casos: precio normal (no candidato), ganga estadística, error fare, ruta sin muestra suficiente (no candidato aunque el precio sea bajo), umbral absoluto, cooldown activo.
- El refresh de stats sobre 500 rutas tarda < 30 s.
- Una corrida típica produce un número razonable de candidatos (instrumentar: si produce > 50, loguear warning — los umbrales están flojos).

---

### Fase 4 — Capa 3: verificación en tiempo real

**Interfaz** (`src/clients/flightVerifier.ts`):

```ts
interface VerificationResult {
  alive: boolean;
  priceUsd?: number;
  airline?: string;
  direct?: boolean;
  bookingUrl?: string;     // deep link a Google Flights
  availableDates?: string[];
}
interface FlightVerifier {
  verify(origin: string, dest: string, departDate: string, returnDate?: string): Promise<VerificationResult>;
}
```

Implementación primaria: **SearchApi.io** (`engine=google_flights`, params `departure_id`, `arrival_id`, `outbound_date`, `return_date`, `currency=USD`). El proveedor se elige por env var `VERIFIER_PROVIDER` (default `searchapi`), dejando el esqueleto para `flightapi`.

**`src/pipeline/verify.ts`:**
1. Tomar candidatos pendientes ordenados por score desc, **máximo 15 por corrida** (control de costo; env var `MAX_VERIFICATIONS_PER_RUN`).
2. Por cada uno: verificar. Regla de confirmación: `verified_price <= cached_price × 1.15` (tolerancia 15% — la caché siempre va a estar algo desfasada).
   - Confirmado → status `verified`, guardar precio/aerolínea/url, notificar al bot de curaduría.
   - Precio subió más de eso o no hay resultados → status `rejected`, `rejection_reason='price_gone'`.
3. Construir `booking_url` como link a Google Flights con la búsqueda armada (formato `https://www.google.com/travel/flights?q=Flights%20from%20{O}%20to%20{D}%20on%20{date}` o el deep link que el verifier devuelva).

**Criterios de aceptación:**
- Tests con fixtures: deal confirmado, precio desaparecido, respuesta vacía, error HTTP (el deal queda `candidate` para reintentar, no `rejected`).
- El costo por corrida está acotado por `MAX_VERIFICATIONS_PER_RUN` — verificable en logs (contador de llamadas pagas por corrida).
- Si la API paga falla por completo (caída/sin créditos), el pipeline no publica nada y lo loguea como error visible. **Nunca degradar a publicar precios de caché.**

**Modo prueba sin costo (vigente hasta decidir pagar):**
- Presupuestos free tier: SearchApi 100 req/mes, SerpApi 250 req/mes. El diseño original (15 verificaciones × 2-3 corridas/día) agotaría SearchApi en un día.
- `SILENT_MODE=true` permanece activo: el cron **nunca** llama APIs pagas (ni verify ni recheck). La verificación se dispara solo manualmente (`npm run verify`).
- `MAX_VERIFICATIONS_PER_RUN=2` durante la prueba (era 15). Cada corrida manual loguea llamadas usadas para llevar la cuenta mensual a ojo.
- El re-chequeo de deals publicados (Fase 5) queda deshabilitado mientras dure el modo prueba — no hay deals publicados aún y consume presupuesto de verificación.
- Salida del modo prueba: cuando el embudo valide (confirma ≥30% de lo verificado), pasar a plan pago de SearchApi y restaurar `MAX_VERIFICATIONS_PER_RUN=15`.

---

### Fase 5 — Bot de curaduría + publicación

**Bot de curaduría** (`src/curation/bot.ts`, grammy):
- Bot privado que solo responde a `CURATOR_CHAT_ID` (ignorar silenciosamente a cualquier otro usuario).
- Al verificarse un deal, envía mensaje con todos los datos (ruta, fechas, precio verificado, descuento vs mediana, aerolínea, directo o no, score, flag de error fare) y botones inline: **✅ Publicar / ❌ Rechazar**.
- Callback de Publicar → publica al canal y transiciona a `published`. Rechazar → `rejected` con `rejection_reason='curator'`.
- Comando `/pending`: lista deals `verified` sin resolver. Comando `/stats`: resumen del día (corridas, candidatos, verificados, publicados, clicks).

**Publicador** (`src/publish/`):
- `format.ts` (función pura, testeable): arma el texto del post:

```
✈️ ¡GANGA! Buenos Aires → Madrid

💵 USD 489 (≈ $X.XXX.XXX dólar tarjeta)
📉 38% más barato que lo habitual en esta ruta
🛫 Iberia · Directo
📅 Fechas: 12-28 de marzo (varias combinaciones)

👉 Ver vuelo: {REDIRECT_URL}/go/{dealId}

⚡ Las tarifas así suelen durar horas. Verificá el precio final antes de pagar.
```

- Conversión ARS: `src/clients/dolar.ts` → `GET https://dolarapi.com/v1/dolares/tarjeta`, cachear la cotización 1 h en memoria. Si dolarapi falla, publicar solo en USD (no bloquear).
- `publish.ts`: envía al canal (`CHANNEL_ID`), guarda `telegram_message_id`.

**Re-chequeo** (`src/pipeline/recheck.ts`, cron cada 12 h):
- Para deals `published` con menos de 72 h: re-verificar con capa 3 (cuenta dentro del presupuesto de llamadas). Si el precio murió → editar el mensaje original anteponiendo `⚠️ EXPIRADO —` y status `expired`.

**Criterios de aceptación:**
- `format.ts` con tests snapshot (con y sin cotización ARS, con y sin return_date, error fare con copy distinto: "🔥 TARIFA ERROR").
- El bot ignora a cualquier chat distinto del curador (test).
- Flujo end-to-end manual documentado en el README: deal de prueba → mensaje al curador → aprobar → aparece en canal de prueba → recheck lo marca expirado si se fuerza.

---

### Fase 6 — Redirect con tracking (Vercel)

**`api/go/[dealId].ts`:**
1. Buscar el deal; si no existe → 404 simple.
2. Insertar `click_events` (deal_id, user_agent, referer). **El insert es fire-and-forget con try/catch: si la DB falla, el redirect sale igual.** El click del usuario nunca se sacrifica por la métrica.
3. `302` a `booking_url`.

**Criterios de aceptación:**
- Latencia del redirect < 300 ms p95 (el insert no bloquea la respuesta).
- Deal inexistente no rompe (404 limpio).

---

### Fase 7 — Orquestación (GitHub Actions)

**`scan.yml`** — cron `0 */8 * * *` (cada 8 h):
```
npm run pipeline   # = scan → detect → verify (verify omitido si SILENT_MODE)
```
**`recheck.yml`** — cron `0 */12 * * *`.

- Secrets del repo: todas las env vars de §7.
- Timeout del job: 30 min. Concurrencia: `cancel-in-progress: false`, grupo único (nunca dos pipelines simultáneos).
- El bot de curaduría corre aparte en modo long-polling. Opciones (documentar ambas en el README, implementar la A): (A) proceso persistente en cualquier host gratuito/casero del operador; (B) webhook en Vercel function. El job de Actions **no** corre el bot; solo le envía mensajes vía API de Telegram (sendMessage directo), y el bot procesa callbacks cuando está activo.

**Criterios de aceptación:**
- Workflow corre verde en Actions de punta a punta contra Supabase real con `SILENT_MODE=true`.
- Logs de cada corrida muestran el resumen: observaciones, candidatos, verificaciones usadas/presupuesto, publicados.

---

## 5. Orden de ejecución y modo de trabajo para Claude Code

1. Una fase por sesión. Antes de codear, releer la fase completa y los criterios de aceptación.
2. Al terminar cada fase: correr `typecheck + lint + test`, actualizar el README si cambió algo operativo, y dejar commit(s) atómicos con mensaje claro.
3. Si una decisión no está cubierta por este documento, elegir la opción más simple que cumpla los criterios y **anotarla en una sección "Decisions" del README** — no preguntar por trivialidades, no sobre-diseñar.
4. No refactorizar fases anteriores salvo que una fase nueva lo exija.

## 6. Fuera de alcance (NO construir, aunque parezca buena idea)

- Frontend web / landing / panel de administración (la curaduría es por Telegram).
- Sistema de usuarios, suscripciones, pagos, Mercado Pago (fase de negocio posterior, no de esta validación).
- Route-watching personalizado por usuario.
- Publicación automática sin aprobación humana (existe `AUTO_PUBLISH` como env var reservada, default `false`, sin implementación detrás).
- Scraping directo de Google Flights o uso de librerías de reverse engineering (fli u otras).
- Más de un canal de notificación (solo Telegram).
- Optimizaciones prematuras: colas, Redis, microservicios. Es un monolito de scripts con cron y está bien que lo sea.

## 7. Variables de entorno

```bash
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=        # service role: el worker escribe sin RLS

# Capa 1
TRAVELPAYOUTS_TOKEN=

# Capa 3
VERIFIER_PROVIDER=searchapi       # searchapi | flightapi
SEARCHAPI_KEY=
FLIGHTAPI_KEY=                    # opcional
MAX_VERIFICATIONS_PER_RUN=2       # 15 en producción paga; 2 en modo prueba free tier

# Bootstrap opcional del baseline
SERPAPI_KEY=                      # opcional

# Telegram
TELEGRAM_BOT_TOKEN=
CURATOR_CHAT_ID=                  # chat privado del operador
CHANNEL_ID=                       # @canal o -100xxxxxxxxxx

# Tracking
REDIRECT_BASE_URL=                # ej: https://go.tudominio.com

# Operación
SILENT_MODE=true                  # true las primeras 1-2 semanas
AUTO_PUBLISH=false                # reservada, no implementar
```

## 8. Métricas instrumentadas desde el día 1

El comando `/stats` del bot y los logs de cada corrida deben poder responder:
- Observaciones de precio por corrida y total acumulado por ruta (densidad del baseline).
- Candidatos generados / verificados / confirmados / publicados por día (salud del embudo: si confirma < 30% de lo verificado, los umbrales de capa 2 están flojos y se quema presupuesto de capa 3).
- Llamadas pagas consumidas vs presupuesto (`MAX_VERIFICATIONS_PER_RUN × corridas`).
- Clicks por deal y CTR aproximado (clicks / views — las views se leen manualmente de Telegram por ahora).
- Deals expirados antes de 24 h (calidad/frescura de lo publicado).

Las métricas de negocio (miembros del canal, kill criteria del mes 3) se siguen fuera del sistema.
