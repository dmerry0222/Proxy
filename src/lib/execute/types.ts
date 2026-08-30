export type ExecutionItemStatus =
  | "candidate"
  | "active"
  | "completed"
  | "cancelled"
  | "deferred";

export type WorkBlockStatus =
  | "proposed"
  | "committed"
  | "completed"
  | "partial"
  | "missed"
  | "cancelled";

export type PriorityDirective = {
  tier: "P1" | "P2" | "P3" | "background";
  why: string;
  desiredOutcome?: string;
  /** Interpreted from the item's own timing_at/timing_kind (Post-Phase-6 Part 8) -- never the source of timing truth, and never written back onto timing_at/timing_kind. */
  timing?: { kind: "must" | "target"; at: string };
  /** How fixed the commitment is -- distinct from timing.kind: a "target" can still be a hard external commitment in spirit. */
  hardness: "hard" | "moderate" | "soft";
  protection: "protected" | "normal" | "flexible";
  mayDisplace: Array<"P2" | "P3" | "background">;
  /** Separate from `protection`/execution priority (Part 8: "should Dave notice this?" vs "should Dave spend execution time on this?"). */
  attentionPriority?: "high" | "normal" | "low";
  reassessAt?: string;
  escalationCondition?: string;
  /** A manual override is never silently overwritten by the next CoS run (Part 11) unless reassessAt has passed. */
  source: "cos" | "manual";
  decidedAt: string;
};

export type ExecuteProject = {
  id: string;
  memoryProjectEntityId: string;
  name: string;
  nextPlateau: string | null;
  priorityDirective: PriorityDirective | null;
};

export type ExecuteItem = {
  id: string;
  projectStateId: string | null;
  projectName: string | null;
  title: string;
  description: string | null;
  status: ExecutionItemStatus;
  responsibility: "mine" | "external";
  effortMinutes: number | null;
  timingKind: "must" | "target" | null;
  timingAt: string | null;
  criticalRank: 1 | 2 | 3 | null;
  waitingSince: string | null;
  expectedAt: string | null;
  relatedPersonName: string | null;
  allocatedMinutes: number;
  confirmedByUser: boolean;
  deferredUntil: string | null;
  priorityDirective: PriorityDirective | null;
};

export type WorkBlockChecklistItem = {
  id: string;
  label: string;
  checked: boolean;
};

export type ExecuteWorkBlock = {
  id: string;
  title: string;
  status: WorkBlockStatus;
  start: string;
  end: string;
  calendarEventId: string | null;
  checklist: WorkBlockChecklistItem[];
  completionNote: string | null;
  items: Array<{
    id: string;
    title: string;
    status: ExecutionItemStatus;
    allocatedMinutes: number | null;
  }>;
};

export type ExecuteCalendarEvent = {
  id: string;
  subject: string;
  start: string;
  end: string;
  showAs: string | null;
  hasOtherPeople: boolean;
  isTouchpoint: boolean;
};

export type ExecuteDashboard = {
  horizonStart: string;
  horizonEnd: string;
  projects: ExecuteProject[];
  availableMemoryProjects: Array<{ id: string; name: string }>;
  items: ExecuteItem[];
  workBlocks: ExecuteWorkBlock[];
  calendarEvents: ExecuteCalendarEvent[];
};
