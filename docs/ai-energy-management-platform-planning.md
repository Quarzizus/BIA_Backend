# AI Energy Management Platform — Project Context

## Objetivo

MVP de plataforma SaaS para gestión de medidores eléctricos. La IA detecta, clasifica, explica y prioriza anomalías en el consumo eléctrico. El valor principal: una persona puede identificar rápidamente qué requiere atención y entender por qué.

---

## Dataset

| Campo Valor  |                                                             |
| ------------ | ----------------------------------------------------------- |
| Medidores    | 12 (M-101 a M-112)                                          |
| Periodo      | 14 días (2026-09-01 a 2026-09-14)                           |
| Lecturas     | 4.032 (336 por medidor, 1 por hora, sin huecos ni nulls)    |
| Variables    | consumption_kwh, voltage_v, current_a, power_factor, status |

**Archivos:** `readings.csv`, `events.csv`

> El campo `status` en readings.csv siempre es `OK`. No sirve para detección, ignorar.

---

## Entidades

### Meter

```
id            String   PK
meter_id      String   unique (ej: "M-109")
name          String
location      String
status        Enum     (NORMAL, ALERT, CRITICAL)
created_at    DateTime

```

### Reading

```
id              String   PK
meter_id        String   FK -> Meter
timestamp       DateTime
consumption_kwh Float
voltage_v       Float
current_a       Float
power_factor    Float
status          String

```

Índice compuesto: `(meter_id, timestamp)`

### Event

```
id               String   PK
meter_id         String   FK -> Meter
event_timestamp  DateTime
event_type       Enum     (OPERATIONAL_CHANGE, SCHEDULED_OUTAGE, DATA_QUALITY, UNKNOWN)
description      String

```

### Anomaly

```
id                  String   PK
meter_id            String   FK -> Meter
detected_at         DateTime
type                Enum     (REAL_ANOMALY, EXPLAINABLE_ANOMALY, FALSE_POSITIVE, DATA_QUALITY)
severity            Enum     (HIGH, MEDIUM, LOW)
confidence          Float
reason              String
recommended_action  String
status              Enum     (OPEN, INVESTIGATING, RESOLVED)
created_at          DateTime

```

---

## Casos de uso

1. Listar todos los medidores con consumo, variación vs baseline y estado
2. Ver detalle de un medidor (consumo actual, baseline, variación, histórico de variables)
3. Ver lecturas de un medidor con filtro de rango de fechas
4. Ejecutar análisis IA (POST /ai/analyze) — corre el pipeline completo
5. Consultar estado de un análisis en curso
6. Listar anomalías detectadas con tipo, severidad, confianza y acción recomendada
7. Ver detalle de una anomalía (investigación completa)
8. Ver resumen del dashboard (KPIs globales)

---

## API REST

```
GET    /meters
GET    /meters/:meterId
GET    /meters/:meterId/readings
GET    /anomalies
GET    /anomalies/:id
POST   /ai/analyze
GET    /ai/analysis/:id
GET    /dashboard/summary

```

---

## Reglas de negocio — Pipeline de análisis

El análisis corre en 3 etapas secuenciales cuando se llama `POST /ai/analyze`.

### Etapa 1: Baseline

- Usar los primeros 7 días (2026-09-01 a 2026-09-07) como baseline por medidor.
- Calcular media y desviación estándar de `consumption_kwh`, `voltage_v`, `current_a` y `power_factor` por medidor en ese periodo.

### Etapa 2: Detección estadística

Detectar tres tipos de señales:

**A. Spike / cambio brusco**

- Z-score por lectura: `(valor - media_baseline) / std_baseline`
- Umbral: Z-score > 3 en consumption_kwh

**B. Cambio persistente**

- Comparar media de los últimos 3 días vs baseline
- Umbral: variación > 20%

**C. Incoherencia eléctrica (data quality)**

- Consumo estable (variación < 5% vs baseline)
- Y simultáneamente: std de voltage_v > 5x su std en baseline, O std de power_factor > 5x su std en baseline
- Esta combinación indica problema de medición, no de consumo

### Etapa 3: Clasificación con eventos

Para cada anomalía detectada, buscar en `events` si existe un evento del mismo meter_id cuyo timestamp esté dentro del rango afectado.

| Condición Clasificación                                             |                              |
| ------------------------------------------------------------------- | ---------------------------- |
| Señal detectada + evento `SCHEDULED_OUTAGE` cubre el rango          | FALSE_POSITIVE / LOW         |
| Señal detectada + evento `OPERATIONAL_CHANGE` cubre el rango        | EXPLAINABLE_ANOMALY / MEDIUM |
| Señal detectada + evento `DATA_QUALITY`                             | DATA_QUALITY / HIGH          |
| Señal detectada + evento `UNKNOWN` o sin evento                     | REAL_ANOMALY / HIGH          |
| Señal ambigua (Z-score borderline o evento no coincide exactamente) | Enviar al LLM para desempate |

---

## Uso de IA (API compatible con OpenAI)

**Modelo:** Configurable mediante un proveedor compatible con la API de OpenAI (por ejemplo OpenAI, DeepSeek u otro proveedor compatible).

La integración debe usar una interfaz compatible con la API de OpenAI, de forma que el proveedor y el modelo puedan cambiarse mediante variables de entorno sin modificar la lógica de negocio.

Ejemplo de configuración:
- `AI_API_KEY`: clave del proveedor.
- `AI_BASE_URL`: URL base compatible con la API de OpenAI.
- `AI_MODEL`: modelo a utilizar.

**Dos puntos de entrada:**

### 1. Clasificación de casos ambiguos

Cuando la señal estadística no es concluyente (Z-score borderline, evento cercano pero no exacto en timestamp). Se le pasa al LLM el contexto del medidor, las métricas y el evento más cercano para que clasifique y asigne confianza.

### 2. Generación de explicación (siempre)

Para toda anomalía confirmada, el LLM genera `reason` y `recommended_action` en lenguaje natural a partir de los datos.

**Payload de entrada al LLM:**

```json
{
  "meter_id": "M-109",
  "baseline_mean_kwh": 43.9,
  "recent_mean_kwh": 82.0,
  "variation_pct": 86.8,
  "max_z_score": 8.76,
  "affected_variables": ["consumption_kwh", "current_a", "power_factor"],
  "related_event": null,
  "detection_type": "PERSISTENT_CHANGE + SPIKE"
}

```

**Output esperado:**

```json
{
  "type": "REAL_ANOMALY",
  "severity": "HIGH",
  "confidence": 0.96,
  "reason": "...",
  "recommended_action": "..."
}

```

---

## Casos del dataset (ground truth)

| Medidor Qué pasa en los datos Resultado esperado  |                                                                                                                                                                 |                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| M-109                                             | Consumo salta de \~44 a \~91 kWh/h el 12-sep a las 14:00. Z-score 8.7. Current_a pasa de 235 A a 492 A. Power_factor cae de 0.93 a 0.73. Evento tipo UNKNOWN.   | REAL_ANOMALY / HIGH          |
| M-112                                             | Consumo estable todo el periodo (\~27.5 kWh/h). Días 13-14: voltage_std salta 10x, power_factor_std salta 10x, pf mínimo cae a 0.58. Evento tipo DATA_QUALITY.  | DATA_QUALITY / HIGH          |
| M-104                                             | Consumo sube de \~48 a \~61 kWh/h (+26.5%) a partir del 11-sep medianoche. Evento tipo OPERATIONAL_CHANGE "New production line activated" con timestamp exacto. | EXPLAINABLE_ANOMALY / MEDIUM |
| M-106                                             | Consumo cae de \~55 a 7-13 kWh/h durante 12 horas el 8-sep. Evento tipo SCHEDULED_OUTAGE "Scheduled maintenance outage for 12 hours" con timestamp exacto.      | FALSE_POSITIVE / LOW         |

---

## Arquitectura — Modular por feature

```
src/
├── config/
│   ├── database.ts
│   └── env.ts
│
├── modules/
│   ├── meters/
│   │   ├── meter.model.ts
│   │   ├── meter.repository.ts
│   │   ├── meter.service.ts
│   │   └── meter.routes.ts
│   │
│   ├── readings/
│   │   ├── reading.model.ts
│   │   ├── reading.repository.ts
│   │   ├── reading.service.ts
│   │   └── reading.routes.ts
│   │
│   ├── anomalies/
│   │   ├── anomaly.model.ts
│   │   ├── anomaly.repository.ts
│   │   ├── anomaly.service.ts
│   │   └── anomaly.routes.ts
│   │
│   ├── analysis/
│   │   ├── analysis.service.ts       # Orquesta el pipeline completo
│   │   ├── baseline.calculator.ts    # Etapa 1
│   │   ├── detector.ts               # Etapa 2 - detección estadística
│   │   ├── classifier.ts             # Etapa 3 - cruce con eventos
│   │   ├── llm.explainer.ts          # Claude API
│   │   └── analysis.routes.ts
│   │
│   └── dashboard/
│       ├── dashboard.service.ts
│       └── dashboard.routes.ts
│
├── shared/
│   ├── errors.ts
│   └── logger.ts
│
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                       # Carga readings.csv y events.csv
│
└── app.ts

```

> El módulo `analysis` está separado de `anomalies`. El análisis es el proceso, las anomalías son el resultado persistido.

---

## Stack

| Capa Tecnología  |                                |
| ---------------- | ------------------------------ |
| Runtime          | Bun                            |
| Framework        | Express                        |
| Base de datos    | PostgreSQL                     |
| ORM              | Prisma                         |
| IA               | API compatible con OpenAI      |
| Frontend         | React + shadcn/ui + Recharts   |
| Infraestructura  | Docker Compose                 |
| Testing          | Vitest (lógica de negocio)     |

---

## Base de datos

**PostgreSQL.** Justificación:

- Los datos tienen esquema fijo y conocido
- Las consultas cruzan tablas por meter_id y rango de tiempo (JOINs)
- Las series temporales se consultan con filtros de rango (índice en timestamp)
- La integridad referencial importa (una anomalía sin medidor válido no tiene sentido)

---

## Infraestructura y entrega

No se despliega a producción. El evaluador clona el repo y ejecuta:

```bash
docker compose up

```

Eso levanta PostgreSQL + backend + frontend. El seed corre automáticamente al iniciar.

El README debe documentar:

- Variables de entorno necesarias (incluyendo la clave del proveedor de IA, por ejemplo `OPENAI_API_KEY`)
- Pasos para levantar el proyecto
- Decisiones técnicas relevantes

---

## Criterios de evaluación (referencia)

### Global

| Área Pts                 |    |
| ------------------------ | -- |
| Frontend / UX            | 20 |
| Backend / API            | 20 |
| Data / Analytics         | 20 |
| Detección de anomalías   | 15 |
| IA y explicabilidad      | 15 |
| Testing / docs / calidad | 10 |

### IA específica

| Criterio Pts                      |    |
| --------------------------------- | -- |
| Detecta M-109                     | 30 |
| Prioriza M-109                    | 25 |
| No trata M-106 como anomalía real | 15 |
| Detecta M-112 como data quality   | 10 |
| Explica con evidencia             | 10 |
| Recomienda acción coherente       | 10 |

---

## Flujo demo (5-10 minutos)

```
Login → Dashboard → Ver M-109 → Run AI Analysis → Ver anomalías → Detalle M-109 → Explicación → Acción recomendada

```