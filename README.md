# AI Energy Management Platform — Backend

MVP de plataforma SaaS para la gestión de medidores eléctricos. La IA detecta, clasifica, explica y prioriza anomalías en el consumo eléctrico: una persona puede identificar rápidamente qué requiere atención y entender por qué.

Este repositorio contiene el **backend** (API REST + pipeline de análisis). El stack es **Bun + Express + PostgreSQL + Prisma**, con un LLM compatible con la API de OpenAI para clasificar casos ambiguos y generar explicaciones en español. Sin autenticación ni frontend (fuera del alcance del slice).

- 12 medidores (M-101 a M-112), 14 días de datos, 4.032 lecturas horarias y 4 eventos.
- 9 endpoints REST + pipeline de análisis asíncrono en 3 etapas (baseline → detección estadística → clasificación con LLM).
- Seed determinista e idempotente; `docker compose up` levanta todo.

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Bun |
| Framework | Express 5 |
| Base de datos | PostgreSQL 16 |
| ORM | Prisma 7 |
| IA | API compatible con OpenAI (configurable por variables de entorno) |
| Infraestructura | Docker Compose |
| Testing | `bun test` (bun:test) + `bunx tsc --noEmit` |

## Camino rápido

1. Copia el contrato de entorno y completa las variables de IA:

   ```bash
   cp .env.example .env
   # edita .env: DATABASE_URL, AI_API_KEY, AI_BASE_URL, AI_MODEL, PORT
   ```

2. Levanta la plataforma (construye la imagen, aplica migraciones, siembra los datos y arranca el servidor):

   ```bash
   docker compose up --build
   ```

3. Verifica que responde:

   ```bash
   curl http://localhost:3000/          # → {"status":"ok"}
   curl http://localhost:3000/meters    # → 12 medidores
   ```

> Para reconstruir la imagen sin cache: `docker compose build --no-cache` y luego `docker compose up`. Para detener todo: `docker compose down` (con `-v` elimina también el volumen de la base de datos; el seed lo re-crea al volver a arrancar).

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | Cadena de conexión a PostgreSQL. Local: `postgresql://bia:bia@localhost:5432/bia_dev`; dentro de compose el host es `postgres`. |
| `AI_API_KEY` | Sí (para análisis) | Clave del proveedor compatible con la API de OpenAI. |
| `AI_BASE_URL` | Sí (para análisis) | URL base del proveedor (ej. `https://api.openai.com/v1`). |
| `AI_MODEL` | Sí (para análisis) | Modelo a usar (ej. `gpt-4o-mini`). |
| `PORT` | No | Puerto HTTP del backend (default `3000`). |

**La clave de IA es obligatoria para ejecutar el análisis.** El servidor arranca sin ella y los endpoints de lectura (`/meters`, `/anomalies`, `/dashboard/summary`) funcionan, pero `POST /ai/analyze` falla rápido con `503 AI_NOT_CONFIGURED` si falta cualquiera de las tres variables `AI_*`. No hay degradación silenciosa: sin LLM no se genera ninguna anomalía.

## Cómo funciona el seed

- **Contrato de copia (D1):** las fuentes viven en `docs/readings.csv` y `docs/events.csv`. El script `bun run sync-seed` las copia a `prisma/seed-data/` (copias versionadas) y falla en voz alta si faltan. El seed resuelve `prisma/seed-data` relativo a su propio archivo (`import.meta.dir`), por lo que `docker compose up` funciona desde cualquier directorio.
- **Idempotente y determinista:** si los conteos ya coinciden (12 medidores / 4.032 lecturas / 4 eventos), el seed imprime `data already present — skipping` y no hace nada. En caso contrario borra y re-crea todo dentro de una única transacción (incluye `analysis_run` y `anomaly`).
- **Timestamps UTC:** los timestamps sin zona horaria del CSV (`2026-09-01 00:00:00`) se normalizan a UTC de forma determinista.
- En `docker compose up`, el contenedor ejecuta `bunx prisma migrate deploy` → `bun prisma/seed.ts` → `bun src/server.ts` (arranque = validación de entorno → verificación de DB → recuperación de runs huérfanos → listen).

## Desarrollo local (sin Docker)

```bash
bun install                      # dependencias
bun run sync-seed                # copia docs/*.csv → prisma/seed-data/
bunx prisma migrate dev          # aplica migraciones a tu DB local
bun run seed                     # siembra (idempotente)
bun run dev                      # arranca con --watch (src/server.ts)
```

## Ejecutar tests

```bash
bun test              # suite completa (unit + integración + E2E sobre bia_test)
bunx tsc --noEmit     # chequeo de tipos
```

Los tests de análisis se ejecutan sobre una base aislada `bia_test` (se crea y siembra automáticamente), de modo que la base de desarrollo `bia_dev` permanece intacta durante la suite.

## API

9 endpoints de negocio + health check. Todos responden JSON; los errores siguen el formato `{"error": {"code": ..., "message": ...}}`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Health check → `{"status":"ok"}`. |
| `GET` | `/meters` | Lista de medidores: consumo más reciente, variación % vs baseline (primeros 7 días) y estado. Ordenados por `meter_id`; medidores sin lecturas → `null`. |
| `GET` | `/meters/:meterId` | Detalle: consumo actual, baseline (media/std de las 4 señales), variación % e historial de variables ascendente. 404 si no existe. |
| `GET` | `/meters/:meterId/readings` | Lecturas con filtro de rango opcional `?from=`/`?to=` (ISO 8601 UTC). `from > to` → 400. |
| `GET` | `/anomalies` | Anomalías (tipo, severidad, confianza, acción recomendada, medidor, estado). Filtros opcionales `?status=` (`OPEN`/`INVESTIGATING`/`RESOLVED`) y `?severity=` (`HIGH`/`MEDIUM`/`LOW`). |
| `GET` | `/anomalies/:id` | Investigación completa: rango afectado, señales (max z, variación), evento relacionado, `reason`/`recommended_action` en español y `analysis_run_id`. |
| `PATCH` | `/anomalies/:id/status` | Transición de estado `{"status": "..."}`; solo `OPEN → INVESTIGATING → RESOLVED`, transición ilegal → 409 `INVALID_STATUS_TRANSITION`. |
| `GET` | `/dashboard/summary` | KPIs globales: consumo total del periodo, medidores `ALERT`/`CRITICAL`, anomalías abiertas por severidad y anomalías recientes. |
| `POST` | `/ai/analyze` | Inicia el análisis asíncrono → `202 {"analysis_id": ...}`. 503 `AI_NOT_CONFIGURED` si falta la clave; 409 `ANALYSIS_IN_PROGRESS` si ya hay un run en curso. |
| `GET` | `/ai/analysis/:id` | Estado del run: `RUNNING`/`COMPLETED`/`FAILED`, resumen y `anomaly_count`. 404 si no existe. |

### Pipeline de análisis (POST /ai/analyze)

1. **Baseline:** media y desviación estándar de `consumption_kwh`, `voltage_v`, `current_a` y `power_factor` de los primeros 7 días (2026-09-01 a 2026-09-07) por medidor.
2. **Detección estadística:** spike (z-score bicaudal), cambio persistente (bloques de 24 h) e incoherencia eléctrica (data quality).
3. **Clasificación:** cruce con eventos del dataset y, para casos ambiguos, el LLM. Cada anomalía confirmada recibe `reason` y `recommended_action` en español generados por el LLM.

## Decisiones técnicas

| # | Decisión | Detalle |
|---|---|---|
| D1 | Seed por copia | `docs/*.csv` se copian a `prisma/seed-data/` (versionados); el seed es independiente del cwd. |
| D2 | Un único run en curso | `lockToken` único (`'single'`) en `AnalysisRun`; insertar otro run → 409 `ANALYSIS_IN_PROGRESS` vía P2002. |
| D3 | Runs huérfanos | Al arrancar, todo `RUNNING` pasa a `FAILED` con `summary='recovered at boot'` y se libera el lock. |
| D4 | `Meter.status` persistido | Se recalcula en la misma transacción del run (y del PATCH de estado) según la anomalía abierta más severa: `HIGH→CRITICAL`, `MEDIUM→ALERT`, resto `NORMAL`. |
| D5 | Cambio persistente por change-point | Bloque de 24 h alineado al día cuya media se desvía >20% del baseline y se sostiene (≥12 lecturas consecutivas desviadas en bloque + el día siguiente mantiene la dirección) → rango `[change_start, end]`. |
| D6 | Cobertura de eventos | `event_timestamp ∈ [range_start, range_end]` (inclusivo). Evento cercano (±6 h, fuera del rango) → caso borderline para el LLM. |
| D7 | LLM obligatorio, fail-fast | Sin `AI_*` → 503 `AI_NOT_CONFIGURED`. Fallo del proveedor a mitad de run → run `FAILED`, `llm_used=false`. Sin degradación a reglas/templates. |
| D8 | LLM inyectable | El clasificador recibe una interfaz `LlmClient`; tests con mock/fake para ejercitar el camino borderline. |
| D9 | Desviación estándar poblacional | Std poblacional (determinista; diferencia despreciable a n=168). |

Además:

- **Spike bicaudal (|z| > 3):** el umbral se aplica al valor absoluto del z-score, de modo que tanto subidas como caídas bruscas (ej. M-106, z ≈ −5.09) se detectan. Un cambio a la baja sin un evento que lo explique sería una anomalía real.
- **Una anomalía consolidada por medidor y por run:** todas las señales detectadas en un medidor se unifican en una sola anomalía (unión de variables afectadas y rango, máximo |z|), evitando ruido duplicado.
- **Ciclo de vida de `AnalysisRun`:** `POST /ai/analyze` responde `202` y ejecuta el pipeline de forma asíncrona (desacoplada); se consulta con `GET /ai/analysis/:id`. La persistencia (anomalías + estado de medidores + run `COMPLETED`) es atómica.
- **Explicaciones en español:** el LLM recibe un prompt en español y devuelve JSON validado con zod; `reason` y `recommended_action` son siempre en español.

### Resultados esperados del análisis (ground truth del dataset)

| Medidor | Señal | Clasificación esperada |
|---|---|---|
| M-109 | Spike + cambio persistente (z ≈ 8.7), evento UNKNOWN | `REAL_ANOMALY` / `HIGH` |
| M-104 | Cambio persistente +26.5 % desde 09-11, evento OPERATIONAL_CHANGE | `EXPLAINABLE_ANOMALY` / `MEDIUM` |
| M-106 | Caída 12 h (z ≈ −5.09), evento SCHEDULED_OUTAGE | `FALSE_POSITIVE` / `LOW` |
| M-112 | Consumo estable + incoherencia eléctrica, evento DATA_QUALITY | `DATA_QUALITY` / `HIGH` |

## Errores

| Status | Código | Condición |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Validación zod / `from > to` en lecturas |
| 404 | `NOT_FOUND` | Recurso inexistente (Prisma P2025 o ruta no definida) |
| 409 | `ANALYSIS_IN_PROGRESS` | Ya hay un run `RUNNING` (P2002 sobre `lockToken`) |
| 409 | `INVALID_STATUS_TRANSITION` | Transición de estado ilegal de una anomalía |
| 503 | `AI_NOT_CONFIGURED` | Faltan `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` al llamar `POST /ai/analyze` |
| 500 | `INTERNAL_ERROR` | Error no manejado |

## Estructura del proyecto

```
src/
├── config/        # env.ts (zod), database.ts (Prisma singleton)
├── modules/
│   ├── meters/    # GET /meters, GET /meters/:meterId
│   ├── readings/  # GET /meters/:meterId/readings
│   ├── anomalies/ # list / detalle / PATCH estado
│   ├── analysis/  # pipeline: baseline, detector, classifier, llm, service, routes
│   └── dashboard/ # GET /dashboard/summary
├── shared/        # errors.ts (ApiError + mapeo), logger.ts
├── testing/       # utilidades de DB aislada para tests (bia_test)
├── app.ts         # fábrica de la app Express
└── server.ts      # bootstrap: env → DB → boot sweep → listen
prisma/
├── schema.prisma  # 6 enums + Meter/Reading/Event/Anomaly/AnalysisRun
├── seed.ts        # seed determinista e idempotente
└── seed-data/     # copias versionadas de readings.csv y events.csv
scripts/sync-seed-data.ts   # contrato de copia docs/ → prisma/seed-data/
docker-compose.yml          # postgres + backend
```

## Documentación de referencia

- [Planificación del proyecto (PRD)](docs/ai-energy-management-platform-planning.md) — requisitos completos, dataset y criterios de evaluación.