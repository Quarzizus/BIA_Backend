import type { AnomalyStatus } from "../../generated/prisma/enums";

/** Allowed forward-only transitions: OPEN -> INVESTIGATING -> RESOLVED. */
const TRANSITIONS: Record<AnomalyStatus, readonly AnomalyStatus[]> = {
  OPEN: ["INVESTIGATING"],
  INVESTIGATING: ["RESOLVED"],
  RESOLVED: [],
};

export function canTransition(from: AnomalyStatus, to: AnomalyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}