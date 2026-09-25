-- AlterTable
ALTER TABLE "analysis_runs" ADD COLUMN     "explanationSource" TEXT,
ADD COLUMN     "newCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refreshedCount" INTEGER NOT NULL DEFAULT 0;
