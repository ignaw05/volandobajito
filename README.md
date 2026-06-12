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
| `npm run scan` | Capa 1: barrido Travelpayouts → `price_history` | 2 |
| `npm run detect` | Capa 2: refresh de stats + detección de candidatos | 3 |
| `npm run verify` | Capa 3: verificación real-time de candidatos | 4 |
| `npm run pipeline` | scan → detect → verify (verify omitido si `SILENT_MODE=true`) | 4 |
| `npm run recheck` | Re-verificación de deals publicados (< 72 h) | 5 |
| `npm run bot` | Bot de curaduría (long-polling, proceso persistente) | 5 |

Los comandos de fases futuras se agregan a `package.json` cuando su fase se implementa.

## Estado de fases

- [x] **Fase 0** — Setup: tooling, config zod fail-fast, `.env.example`
- [x] **Fase 1** — Schema de base de datos + seed de rutas
- [ ] **Fase 2** — Capa 1: scanner (Travelpayouts)
- [ ] **Fase 3** — Capa 2: detección estadística
- [ ] **Fase 4** — Capa 3: verificación en tiempo real
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
