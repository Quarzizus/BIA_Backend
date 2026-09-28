# AI Energy Management Platform — Backend

MVP de plataforma SaaS para la gestión de medidores eléctricos. La IA detecta, clasifica, explica y prioriza anomalías en el consumo eléctrico: una persona puede identificar rápidamente qué requiere atención y entender por qué.

Este repositorio contiene el **backend** (API REST + pipeline de análisis). Stack, arquitectura y funcionamiento del análisis: [docs/architecture.md](docs/architecture.md).

- 12 medidores (M-101 a M-112), 14 días, 4.032 lecturas horarias y 4 eventos.
- 9 endpoints REST + análisis asíncrono, todos protegidos por autenticación.
- `docker compose up` levanta PostgreSQL + backend con datos sembrados y el usuario admin de la demo.

## Camino rápido

1. Crea el archivo `.env` en la raíz con las variables de entorno que recibiste
   (referencia en [Variables de entorno](#variables-de-entorno)).
2. Levanta la plataforma (construye, migra, siembra y arranca):

   ```bash
   docker compose up --build
   ```

3. Verifica:

   ```bash
   curl http://localhost:3000/          # → {"status":"ok"}
   ```

Documentación interactiva de la API: http://localhost:3000/docs (spec OpenAPI en http://localhost:3000/openapi.yaml). `/`, `/docs`, `/openapi.yaml` y `/api/auth/*` son públicas; el resto requiere sesión.

Para detener: `docker compose down` (con `-v` elimina también el volumen de datos; el seed lo re-crea al arrancar de nuevo).

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | Sí | Conexión a PostgreSQL. Local: `postgresql://bia:bia@localhost:5432/bia_dev`; en compose el host es `postgres`. |
| `AI_API_KEY` | Sí (para análisis) | Clave del proveedor compatible con la API de OpenAI. |
| `AI_BASE_URL` | Sí (para análisis) | URL base del proveedor (ej. `https://api.openai.com/v1`). |
| `AI_MODEL` | Sí (para análisis) | Modelo a usar (ej. `gpt-4o-mini`). |
| `BETTER_AUTH_SECRET` | Sí | Secreto de firma de sesiones de better-auth (≥ 32 caracteres; `openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | Sí | URL pública del backend (ej. `http://localhost:3000`). |
| `ADMIN_EMAIL` | No | Email del usuario admin sembrado (default `admin@example.com`). |
| `ADMIN_PASSWORD` | No | Password del admin sembrado (default `Admin123!` — no lo uses en producción). |
| `PORT` | No | Puerto HTTP (default `3000`). |

La clave de IA es obligatoria para ejecutar el análisis: sin ella, `POST /ai/analyze` responde `503 AI_NOT_CONFIGURED`. El servidor arranca igual y los endpoints de lectura funcionan.

## Desarrollo local (sin Docker)

```bash
bun install
bun run sync-seed      # copia docs/*.csv → prisma/seed-data/
bunx prisma migrate dev
bun run seed
bun run dev
```

## Ejecutar tests

```bash
bun test              # suite completa sobre bases aisladas bia_test_*
bunx tsc --noEmit     # chequeo de tipos
bun run lint          # linter (incluye deprecaciones)
```

## Documentación

- [Arquitectura](docs/architecture.md) — stack, convención de capas, pipeline de análisis y errores.