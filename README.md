# flight-deals

Motor que detecta precios anómalamente bajos de vuelos con salida desde Argentina, los verifica en tiempo real y los publica (con curaduría humana) en un canal de Telegram.

> Plan completo: [PLAN_IMPLEMENTACION.md](./PLAN_IMPLEMENTACION.md). Principio rector: **nunca se publica un precio sin verificación en tiempo real**.

## Setup

```bash
npm install
cp .env.example .env   # completar credenciales
```

Requiere Node 20+. Las variables de entorno se validan al arranque (`src/config.ts`): si falta una, el proceso muere indicando cuál.

## Migraciones

Las migraciones son SQL plano en `migrations/`, numeradas y se aplican en orden contra Supabase:

```bash
# Opción A: SQL Editor de Supabase — pegar el contenido de cada archivo en orden.
# Opción B: psql contra el connection string del proyecto (Settings → Database):
psql "$SUPABASE_DB_URL" -f migrations/001_initial_schema.sql
psql "$SUPABASE_DB_URL" -f migrations/002_route_seed.sql
```

- `001_initial_schema.sql` — schema completo: `routes`, `price_history`, `route_stats`, `deals` (+ enum `deal_status`), `click_events`.
- `002_route_seed.sql` — seed de 480 rutas (5 orígenes × 96 destinos). **Generado** desde `src/db/routeSeed.ts`; regenerar con `npm run seed-routes -- --sql > migrations/002_route_seed.sql`.

Alternativa al SQL de seed: `npm run seed-routes` upsertea las mismas rutas vía supabase-js (idempotente, solo necesita `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en `.env`).

## Comandos

| Comando | Qué hace | Fase |
|---|---|---|
| `npm run typecheck` | TypeScript estricto sin emitir | ✅ 0 |
| `npm run lint` / `lint:fix` | Biome (lint + format) | ✅ 0 |
| `npm test` | Vitest | ✅ 0 |
| `npm run seed-routes` | Pobla la tabla `routes` (480 rutas; `-- --sql` imprime el SQL) | ✅ 1 |
| `npm run scan` | Capa 1: barrido Travelpayouts → `price_history` | ✅ 2 |
| `npm run bootstrap-baseline` | Opcional: siembra baseline vía SerpApi (omite si no hay `SERPAPI_KEY`) | ✅ 2 |
| `npm run detect` | Capa 2: refresh de stats + detección de candidatos | ✅ 3 |
| `npm run verify` | Capa 3: verificación real-time de candidatos (⚠️ gasta cuota paga) | ✅ 4 |
| `npm run pipeline` | scan → detect → verify (verify omitido si `SILENT_MODE=true`) | 4 |
| `npm run recheck` | Re-verificación de deals publicados (< 72 h) | 5 |
| `npm run bot` | Bot de curaduría (long-polling, proceso persistente) | 5 |

Los comandos de fases futuras se agregan a `package.json` cuando su fase se implementa.

## Estado de fases

- [x] **Fase 0** — Setup: tooling, config zod fail-fast, `.env.example`
- [x] **Fase 1** — Schema de base de datos + seed de rutas
- [x] **Fase 2** — Capa 1: scanner (Travelpayouts)
- [x] **Fase 3** — Capa 2: detección estadística
- [x] **Fase 4** — Capa 3: verificación en tiempo real
- [ ] **Fase 5** — Bot de curaduría + publicación
- [ ] **Fase 6** — Redirect con tracking (Vercel)
- [ ] **Fase 7** — Orquestación (GitHub Actions)

## Decisions

- **Fase 0:** el repo vive en la raíz de este directorio (no en un subdirectorio `flight-deals/` como sugiere el árbol del plan) — un nivel menos de anidado, mismo layout interno.
- **Fase 0:** `SILENT_MODE` defaultea a `true` cuando no está seteado. Ante configuración incompleta el sistema no publica nada, alineado con el principio rector.
- **Fase 0:** la key de capa 3 requerida depende del proveedor: `SEARCHAPI_KEY` si `VERIFIER_PROVIDER=searchapi`, `FLIGHTAPI_KEY` si `flightapi`. La otra es opcional.
- **Fase 0:** `dotenv` carga `.env` en desarrollo local; en GitHub Actions las vars vienen de secrets y `.env` simplemente no existe.
- **Fase 1:** universo de rutas = producto cartesiano completo de 5 orígenes × 96 destinos (480 rutas). Algunas combinaciones no tienen servicio real (p.ej. AEP→Europa); la API de capa 1 devuelve vacío para esas y el scanner lo tolera — más simple que curar el grafo a mano.
- **Fase 1:** región `other` sin `sanity_threshold_usd` (NULL): el plan solo fija umbrales para regional/caribbean/usa/europe.
- **Fase 1:** `002_route_seed.sql` se genera desde `src/db/routeSeed.ts` (única fuente de verdad) para evitar drift entre el SQL y el script de seed.
- **Fase 1:** `loadConfigSubset(...)` permite que scripts standalone (como el seed) validen solo las env vars que usan, manteniendo fail-fast; el pipeline completo seguirá usando `loadConfig()`.
- **Fase 1:** los tests de `db/queries.ts` usan mocks finos del builder de supabase-js (no hay Postgres local garantizado en el entorno de dev).
- **Fase 1 (cierre):** las migraciones `001` y `002` se aplicaron al proyecto Supabase `BotVuelos` vía el MCP de Supabase (`apply_migration`), quedando registradas en el historial de migraciones del proyecto. Verificado: 480 rutas activas sin duplicados.
- **Fase 2:** el barrido mensual cubre el mes corriente + 3 siguientes (4 requests por ruta).
- **Fase 2:** `direct` se considera `true` solo si ida **y** vuelta son sin escalas (`transfers=0` y `return_transfers` 0 o ausente); `null` cuando la API no informa escalas.
- **Fase 2:** entradas individuales malformadas en la respuesta se descartan sin abortar el barrido; un envelope inesperado o `success=false` sí es error (y reintenta a nivel request).
- **Fase 2:** el rate limiter espacia requests en serie (1 cada 200 ms = 300 req/min); ante 429 duerme según `X-Rate-Limit-Reset` (epoch o delta, acotado a 90 s) y ante `X-Rate-Limit-Remaining: 0` pausa proactivamente.
- **Fase 2:** `npm run scan` valida solo las env vars que usa (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRAVELPAYOUTS_TOKEN`) vía `loadConfigSubset`, igual que el seed; el orquestador de Fase 7 usará `loadConfig()` completo.
- **Fase 2:** "las 60 rutas principales" del bootstrap = las primeras 60 rutas activas con origen EZE (aeropuerto internacional principal), en orden de seed.
- **Fase 2 (operación):** se adelantó un `scan.yml` mínimo (cron cada 8 h, solo barrido) para acumular baseline mientras se construyen las fases restantes; la Fase 7 lo extiende al pipeline completo. Requiere Node 22 en el runner (supabase-js necesita WebSocket nativo).
- **Fase 3:** el refresh de stats vive en una función SQL (`refresh_route_stats`, migración 003) llamada por RPC — `percentile_cont` corre server-side como exige el plan.
- **Fase 3:** "precio reciente de la última corrida" = observaciones `travelpayouts` de las últimas 12 h (constante `LOOKBACK_HOURS`, cubre el cron de 8 h con margen).
- **Fase 3:** se crea **un deal por ruta por corrida**: la observación calificante más barata; las demás fechas calificantes alimentan el `breadth_bonus`. El cooldown de 72 h ya impone un deal por ruta de todos modos.
- **Fase 3:** `is_error_fare` requiere estadística usable (≥25 muestras); un precio bajo el umbral absoluto sin muestra suficiente es candidato pero nunca error fare (sin mediana confiable no hay "50% de la mediana").
- **Fase 3:** `region_weight` para `other` = 0 (el plan no lo define).
- **Fase 3:** `getRecentObservations` pagina de a 1000 filas — PostgREST capea las respuestas y un barrido completo inserta ~2000 (bug encontrado en el smoke test real: evaluaba solo las primeras 1000).
- **Fase 4 (modo prueba sin costo):** free tiers — SearchApi 100 req/mes, SerpApi 250 req/mes. `MAX_VERIFICATIONS_PER_RUN=2`, `SILENT_MODE=true` (el cron jamás llama APIs pagas) y `npm run verify` solo se corre a mano. Ver §Fase 4 del plan.
- **Fase 4:** SearchApi reporta "sin resultados" como **HTTP 200 + campo `error`** (descubierto en vivo). Ese caso es `alive=false` → `rejected`; cualquier otro string de error con 200 lanza excepción y el deal queda `candidate` (nunca rechazar por un fallo del proveedor).
- **Fase 4:** los candidatos se verifican ordenados por `is_error_fare desc, score desc` — las tarifas error tienen prioridad máxima de cola, como pide la Fase 3.
- **Fase 4:** sin `return_date` la búsqueda lleva `flight_type=one_way`; el `booking_url` usa el deep link del proveedor si viene, si no el formato `google.com/travel/flights?q=...`.
- **Fase 4:** hallazgo operativo: deals originados en low-cost (JetSmart) pueden no ser armables como ida+vuelta en Google Flights → `price_gone`. Si la tasa de confirmación da muy baja por esto, considerar verificar tramos one-way por separado (decisión futura, no implementado).
