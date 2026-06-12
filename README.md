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
| `npm run pipeline` | scan → detect → verify (verify omitido si `SILENT_MODE=true`) | ✅ 7 |
| `npm run recheck` | Re-verificación de deals publicados (< 72 h; ⚠️ gasta cuota paga, no-op si `SILENT_MODE=true`) | ✅ 5 |
| `npm run bot` | Bot de curaduría (long-polling, proceso persistente) | ✅ 5 |

Los comandos de fases futuras se agregan a `package.json` cuando su fase se implementa.

## Prueba end-to-end manual (Fase 5)

Requiere un bot de Telegram de prueba y un canal de prueba en `.env` (`TELEGRAM_BOT_TOKEN`, `CURATOR_CHAT_ID`, `CHANNEL_ID`, `REDIRECT_BASE_URL`).

1. **Deal de prueba** — insertarlo ya verificado en Supabase (SQL Editor), así no gasta cuota de verificación:

   ```sql
   insert into deals (route_id, status, depart_date, return_date,
                      cached_price_usd, verified_price_usd, airline, direct,
                      median_at_detection, discount_pct, score, verified_at)
   select id, 'verified', current_date + 30, current_date + 45,
          489, 489, 'Test Air', true, 800, 0.39, 60, now()
   from routes where origin = 'EZE' and destination = 'MAD';
   ```

2. **Bot de curaduría** — `npm run bot` y, en el chat del curador, enviar `/pending`: llega la alerta del deal con botones ✅ Publicar / ❌ Rechazar. (Cuando el deal lo confirma `npm run verify`, la alerta llega sola.)
3. **Aprobar** — tocar ✅ Publicar: el post aparece en el canal de prueba, el deal pasa a `published` con `telegram_message_id` y la alerta queda marcada "✅ Publicado en el canal".
4. **Forzar expiración** — `SILENT_MODE=false npm run recheck` (⚠️ 1 llamada paga por deal publicado). Como la tarifa de prueba no existe en vivo, el verifier no la encuentra: el post del canal se edita con el banner `⚠️ EXPIRADO —` y el deal pasa a `expired`.
5. **Limpieza** — borrar el deal de prueba: `delete from deals where airline = 'Test Air';`

## Redirect con tracking (Fase 6)

Los posts del canal linkean a `{REDIRECT_BASE_URL}/go/{dealId}`. Esa URL la sirve una función de Vercel (`api/go/[dealId].ts`): busca el deal, registra el click en `click_events` en segundo plano y responde `302` al `booking_url`. Deal inexistente, id malformado o deal sin `booking_url` → `404` de texto plano. `vercel.json` reescribe `/go/:dealId` → `/api/go/:dealId`.

Despliegue:

1. `npx vercel link` (o importar el repo desde el dashboard de Vercel; no hay framework, solo `api/`).
2. Configurar en el proyecto de Vercel las env vars `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (la función no necesita las demás).
3. `npx vercel deploy --prod` y apuntar `REDIRECT_BASE_URL` (en `.env` y en los secrets de Actions) al dominio resultante, p. ej. `https://<proyecto>.vercel.app`.

Prueba manual: con un deal publicado, abrir `{REDIRECT_BASE_URL}/go/{dealId}` → redirige al booking y aparece una fila en `click_events`; `{REDIRECT_BASE_URL}/go/cualquier-cosa` → 404.

## Orquestación (Fase 7)

Dos workflows de GitHub Actions, ambos en el grupo de concurrencia `pipeline` (`cancel-in-progress: false`): nunca corren dos a la vez porque comparten el proveedor de verificación y su presupuesto de llamadas pagas.

- **`scan.yml`** (`pipeline` en la UI de Actions) — cron cada 8 h: `npm run pipeline` = scan → detect → verify. Con `SILENT_MODE=true` (default) verify se saltea y la corrida no gasta llamadas pagas. Cada corrida cierra con el resumen del embudo de las últimas 24 h (candidatos / verificados / publicados / clicks); cada etapa ya loguea el suyo (observaciones, candidatos, llamadas pagas usadas/presupuesto).
- **`recheck.yml`** — cron cada 12 h: `npm run recheck`. No-op mientras `SILENT_MODE=true`.

Secrets del repo (Settings → Secrets and variables → Actions): las env vars de `.env.example`. Para arrancar en modo silencioso alcanza con `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `TRAVELPAYOUTS_TOKEN` — el resto solo se valida cuando `SILENT_MODE=false`. Los knobs no sensibles tienen default inline en el workflow (`SILENT_MODE` → `true`, `MAX_VERIFICATIONS_PER_RUN` → `2`, `VERIFIER_PROVIDER` → `searchapi`).

El bot de curaduría **no** corre en Actions. El pipeline le manda la alerta al curador vía sendMessage directo; los callbacks se procesan cuando el bot está activo. Opciones de hosting:

- **(A) — implementada:** proceso persistente long-polling en cualquier host del operador (`npm run bot`): una compu propia, una Raspberry, un VPS gratuito. Si el bot está caído al llegar una alerta, los botones quedan pendientes y `/pending` los recupera al reiniciar.
- **(B) — no implementada:** webhook en una función de Vercel (`setWebhook` de Telegram apuntando a un endpoint en `api/`). Sin proceso persistente, pero exige validar `secret_token` y duplicar en serverless el wiring del bot.

## Estado de fases

- [x] **Fase 0** — Setup: tooling, config zod fail-fast, `.env.example`
- [x] **Fase 1** — Schema de base de datos + seed de rutas
- [x] **Fase 2** — Capa 1: scanner (Travelpayouts)
- [x] **Fase 3** — Capa 2: detección estadística
- [x] **Fase 4** — Capa 3: verificación en tiempo real
- [x] **Fase 5** — Bot de curaduría + publicación
- [x] **Fase 6** — Redirect con tracking (Vercel)
- [x] **Fase 7** — Orquestación (GitHub Actions)

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
- **Fase 5:** el gate del curador es un middleware silencioso: cualquier update cuyo chat no sea `CURATOR_CHAT_ID` se descarta sin respuesta ni log (nada que un tercero pueda sondear).
- **Fase 5:** `/pending` reenvía cada deal `verified` sin resolver con botones frescos (máx. 10 por invocación) — una alerta perdida siempre es recuperable.
- **Fase 5:** `/stats` cubre las últimas 24 h con los contadores del embudo (candidatos/verificados/publicados/clicks). Las "corridas" no se persisten en DB; se ven en los logs de Actions (más simple que una tabla de runs).
- **Fase 5:** el texto del post no se guarda: `recheck` lo regenera desde la fila del deal para editar el mensaje expirado. La cifra en ARS puede diferir levemente de la original (cotización del momento) — irrelevante en una tarifa muerta.
- **Fase 5:** si la edición del post del canal falla, el deal igual pasa a `expired`: un banner desactualizado es recuperable, una tarifa muerta como `published` no.
- **Fase 5:** `npm run recheck` es no-op con `SILENT_MODE=true` (modo prueba: el cron jamás gasta llamadas pagas) y comparte el presupuesto `MAX_VERIFICATIONS_PER_RUN` con verify.
- **Fase 5:** el bot corre con la opción (A) del plan: proceso persistente long-polling en un host del operador (`npm run bot`). El pipeline no necesita el bot activo para notificar — `verify` envía la alerta vía sendMessage directo y los callbacks se procesan cuando el bot está corriendo.
- **Fase 6:** la lógica vive en `src/redirect/redirect.ts` con deps inyectadas (mismo patrón que el resto); `api/go/[dealId].ts` es solo el adaptador de Vercel. Así los criterios de aceptación se prueban offline sin runtime de Vercel.
- **Fase 6:** el insert del click se agenda con `waitUntil` de `@vercel/functions`, no con una promesa suelta — en serverless una promesa sin await puede morir cuando la respuesta sale. La respuesta no espera al insert (criterio de latencia) y un insert fallido solo se loguea.
- **Fase 6:** un click de usuario nunca recibe `500`: id malformado (se valida formato uuid antes de tocar la DB), deal inexistente, deal sin `booking_url` o incluso lookup fallido (Supabase caída) responden `404`; el error se loguea. El único `500` posible es env mal configurado en Vercel.
- **Fase 6:** el redirect funciona para cualquier deal existente sin importar su `status` — un post expirado conserva el link vivo; el banner ⚠️ EXPIRADO ya avisa que la tarifa murió.
- **Fase 6:** la función usa `parseEnvSubset` (lanza `ConfigError`) en vez de `loadConfigSubset` (hace `process.exit`), que no corresponde en serverless. El cliente de Supabase se crea lazy y se reusa entre invocaciones warm.
- **Fase 6:** sin `@vercel/node`: sus tipos arrastran ~117 paquetes con vulnerabilidades conocidas. El handler se tipa con `node:http` más una interfaz mínima para `req.query` (lo único no estándar que usa del runtime de Vercel).
- **Fase 7:** el orquestador (`src/pipeline/run.ts`) reusa los `main()` exportados de scan/detect/verify en el mismo proceso — cero duplicación de wiring, y cada etapa sigue validando solo las env vars que necesita (una corrida silenciosa no exige los secrets de Telegram/verifier).
- **Fase 7:** una etapa que falla aborta el pipeline (las siguientes solo operarían sobre datos viejos) y deja la corrida en rojo en Actions.
- **Fase 7:** los secrets sin setear llegan a Actions como `""` (no `undefined`), lo que rompería la validación zod; los knobs no sensibles llevan default inline en el workflow (`|| 'true'`, `|| '2'`, `|| 'searchapi'`). Resultado: un repo recién configurado corre silencioso por defecto.
- **Fase 7:** `scan.yml` conserva su nombre de archivo (continuidad del historial de corridas) pero el workflow se muestra como `pipeline` en la UI de Actions.
- **Fase 7:** el resumen "publicados" del criterio de aceptación sale del embudo de 24 h (`getFunnelStatsSince`, el mismo de `/stats`) — el pipeline no publica por sí mismo (curaduría humana), así que no hay contador propio de la corrida.
