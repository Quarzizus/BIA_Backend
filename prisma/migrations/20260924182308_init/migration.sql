-- CreateEnum
CREATE TYPE "MeterStatus" AS ENUM ('NORMAL', 'ALERT', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('OPERATIONAL_CHANGE', 'SCHEDULED_OUTAGE', 'DATA_QUALITY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('REAL_ANOMALY', 'EXPLAINABLE_ANOMALY', 'FALSE_POSITIVE', 'DATA_QUALITY');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AnomalyStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "meters" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "status" "MeterStatus" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "readings" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "consumptionKwh" DOUBLE PRECISION NOT NULL,
    "voltageV" DOUBLE PRECISION NOT NULL,
    "currentA" DOUBLE PRECISION NOT NULL,
    "powerFactor" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "eventType" "EventType" NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomalies" (
    "id" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "relatedEventId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "AnomalyType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "recommendedAction" TEXT,
    "status" "AnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "rangeStart" TIMESTAMP(3) NOT NULL,
    "rangeEnd" TIMESTAMP(3) NOT NULL,
    "detectionType" TEXT NOT NULL,
    "signals" JSONB NOT NULL,

    CONSTRAINT "anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_runs" (
    "id" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL,
    "lockToken" TEXT,
    "summary" TEXT,
    "llmUsed" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meters_meterId_key" ON "meters"("meterId");

-- CreateIndex
CREATE UNIQUE INDEX "readings_meterId_timestamp_key" ON "readings"("meterId", "timestamp");

-- CreateIndex
CREATE INDEX "events_meterId_eventTimestamp_idx" ON "events"("meterId", "eventTimestamp");

-- CreateIndex
CREATE INDEX "anomalies_meterId_status_idx" ON "anomalies"("meterId", "status");

-- CreateIndex
CREATE INDEX "anomalies_analysisRunId_idx" ON "anomalies"("analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_runs_lockToken_key" ON "analysis_runs"("lockToken");

-- AddForeignKey
ALTER TABLE "readings" ADD CONSTRAINT "readings_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "meters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "meters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "meters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_relatedEventId_fkey" FOREIGN KEY ("relatedEventId") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
