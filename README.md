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
# Opción B: psql contra el connection string del proyecto:
psql "$SUPABASE_DB_URL" -f migrations/001_initial_schema.sql
```

*(Las migraciones se crean en la Fase 1.)*

## Comandos

| Comando | Qué hace | Fase |
|---|---|---|
| `npm run typecheck` | TypeScript estricto sin emitir | ✅ 0 |
| `npm run lint` / `lint:fix` | Biome (lint + format) | ✅ 0 |
| `npm test` | Vitest | ✅ 0 |
| `npm run seed-routes` | Pobla la tabla `routes` (~400-500 rutas) | 1 |
| `npm run scan` | Capa 1: barrido Travelpayouts → `price_history` | 2 |
| `npm run detect` | Capa 2: refresh de stats + detección de candidatos | 3 |
| `npm run verify` | Capa 3: verificación real-time de candidatos | 4 |
| `npm run pipeline` | scan → detect → verify (verify omitido si `SILENT_MODE=true`) | 4 |
| `npm run recheck` | Re-verificación de deals publicados (< 72 h) | 5 |
| `npm run bot` | Bot de curaduría (long-polling, proceso persistente) | 5 |

Los comandos de fases futuras se agregan a `package.json` cuando su fase se implementa.

## Estado de fases

- [x] **Fase 0** — Setup: tooling, config zod fail-fast, `.env.example`
- [ ] **Fase 1** — Schema de base de datos + seed de rutas
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
