export type ArtifactType =
  | "transcript"
  | "summary"
  | "personal_notes"
  | "agenda"
  | "chat_export"
  | "recording"
  | "attachment"
  | "other";

export type ArtifactContextHint = "auto" | "general" | "meeting";
export type ArtifactContentKind = "unclassified" | "general" | "meeting";

export type IngestionInput = {
  artifactType: ArtifactType;
  sourceSystem: string;
  externalId?: string | null;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  title?: string | null;
  occurredAt?: string | null;
  contextHint?: ArtifactContextHint;
  userIntent?: string | null;
  submissionKind?: "file" | "pasted_text";
  metadata?: Record<string, unknown>;
};

export type ParsedFrontmatter = Record<
  string,
  string | number | boolean | string[] | null
>;

export type ParsedSection = {
  ordinal: number;
  sectionType: string;
  heading: string | null;
  content: string;
  startLine: number;
  endLine: number;
};

export type ParsedDocument = {
  supported: boolean;
  text: string;
  frontmatter: ParsedFrontmatter;
  sections: ParsedSection[];
  parserName: string;
  parserVersion: number;
};

export type IngestionResult = {
  duplicate: boolean;
  meetingId?: string;
  artifactId?: string;
  sourceId?: string;
  storedOnly?: boolean;
  calendarMatch?: {
    eventId: string;
    subject: string | null;
    score: number;
    status: string;
  } | null;
  sectionsCreated?: number;
  tasksCreated?: number;
  claimsCreated?: number;
  pendingContextCreated?: number;
  evidenceCreated?: number;
  contentKind?: ArtifactContentKind;
  warnings?: string[];
};
