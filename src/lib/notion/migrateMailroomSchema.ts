import "server-only";

import { emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import { notionClient } from "./client";
import { MAILROOM_PROPERTIES, RETIRED_MAILROOM_PROPERTIES } from "./mailroomSchema";
import { getSurfaceMapping } from "./mapping";
import {
  buildSchemaPatch,
  diffDataSourceSchema,
  type ActualSchema,
  type ExpectedSchema,
  type SchemaDiff,
} from "./schemaDiff";

export type SchemaPropertySnapshot = {
  name: string;
  type: string;
  options?: string[];
};

export type MailroomSchemaMigrationReport = {
  dataSourceId: string | null;
  dryRun: boolean;
  /** True when the migration made no changes because none were needed. */
  alreadyInSync: boolean;
  expectedProperties: SchemaPropertySnapshot[];
  actualPropertiesBefore: SchemaPropertySnapshot[];
  actualPropertiesAfter: SchemaPropertySnapshot[];
  propertiesAdded: string[];
  propertiesChanged: { property: string; addedOptions: string[] }[];
  /**
   * Present in Notion, absent from the expected contract, never written.
   * Retained rather than deleted so existing Notion views don't break.
   * `supersededBy` is populated for the properties this build knowingly
   * retired; an unrecognized extra property (e.g. one added by hand in
   * Notion) is reported with supersededBy = null.
   */
  legacyPropertiesRetained: { name: string; supersededBy: string | null }[];
  /** Reported, never auto-patched -- retyping destroys stored data. */
  typeMismatches: { property: string; expected: string; actual: string }[];
  error: string | null;
};

function snapshot(schema: ExpectedSchema | ActualSchema): SchemaPropertySnapshot[] {
  return Object.entries(schema)
    .map(([name, def]) => {
      const options =
        def.type === "select" && def.select
          ? def.select.options.map((option) => option.name)
          : def.type === "multi_select" && def.multi_select
            ? def.multi_select.options.map((option) => option.name)
            : undefined;
      return options ? { name, type: def.type, options } : { name, type: def.type };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function report(
  base: Partial<MailroomSchemaMigrationReport> & { dataSourceId: string | null; dryRun: boolean }
): MailroomSchemaMigrationReport {
  return {
    alreadyInSync: false,
    expectedProperties: snapshot(MAILROOM_PROPERTIES as ExpectedSchema),
    actualPropertiesBefore: [],
    actualPropertiesAfter: [],
    propertiesAdded: [],
    propertiesChanged: [],
    legacyPropertiesRetained: [],
    typeMismatches: [],
    error: null,
    ...base,
  };
}

function changedFromDiff(diff: SchemaDiff): { property: string; addedOptions: string[] }[] {
  return diff.missingSelectOptions.map((entry) => ({ property: entry.property, addedOptions: entry.options }));
}

function describeLegacy(names: string[]): { name: string; supersededBy: string | null }[] {
  return names.map((name) => ({
    name,
    supersededBy: RETIRED_MAILROOM_PROPERTIES.find((retired) => retired.name === name)?.supersededBy ?? null,
  }));
}

/**
 * Brings the live Notion Mailroom data source into compliance with
 * MAILROOM_PROPERTIES, and returns an explicit before/after report.
 *
 * This exists as its own operation, separate from the schema patch that
 * ensureWorkspaceDatabase performs on every sync, for two reasons the
 * Mailroom repair brief calls out directly:
 *
 *  1. That patch swallows its errors (best-effort, so a schema problem can
 *     never block the page sync behind it). Useful as a background repair,
 *     useless as a verification: "the code called dataSources.update()" is
 *     not evidence the live schema changed. This path surfaces the API
 *     error instead, both in the returned report and as a diagnostic issue.
 *
 *  2. It reads the schema back from Notion afterwards rather than assuming
 *     the write took effect, so the "after" column is observed, not
 *     predicted.
 *
 * Idempotent: when the live schema already matches, no Notion write is
 * issued at all (buildSchemaPatch returns an empty payload) and the report
 * comes back with alreadyInSync = true.
 */
export async function migrateMailroomSchema(options: {
  dryRun: boolean;
  traceId: string | null;
}): Promise<MailroomSchemaMigrationReport> {
  const { dryRun, traceId } = options;

  const mapping = await getSurfaceMapping("notion_workspace_database", "mailroom_conversations");
  const dataSourceId = mapping?.externalObjectId ?? null;

  if (!dataSourceId) {
    return report({
      dataSourceId: null,
      dryRun,
      error:
        "No Notion Mailroom data source is mapped in surface_objects. Run a Mailroom → Notion sync first to create the database.",
    });
  }

  const expected = MAILROOM_PROPERTIES as ExpectedSchema;

  let before: ActualSchema;
  try {
    const live = await notionClient.dataSources.retrieve({ data_source_id: dataSourceId });
    before = (live as unknown as { properties: ActualSchema }).properties;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Notion error";
    await recordIssue({
      traceId,
      issueType: "notion_schema_read_failed",
      severity: "error",
      humanSummary: "Could not read the live Notion Mailroom schema",
      objectType: "notion_workspace_database",
      objectId: "mailroom_conversations",
      retryable: true,
      technicalDetail: message,
    });
    return report({ dataSourceId, dryRun, error: `Could not retrieve live Notion schema: ${message}` });
  }

  const diff = diffDataSourceSchema(expected, before);
  const patch = buildSchemaPatch(expected, before, diff);
  const patchedNames = Object.keys(patch);

  const baseReport = report({
    dataSourceId,
    dryRun,
    alreadyInSync: diff.inSync,
    actualPropertiesBefore: snapshot(before),
    actualPropertiesAfter: snapshot(before),
    propertiesAdded: diff.missingProperties,
    propertiesChanged: changedFromDiff(diff),
    legacyPropertiesRetained: describeLegacy(diff.legacyProperties),
    typeMismatches: diff.typeMismatches,
  });

  if (diff.typeMismatches.length > 0) {
    await recordIssue({
      traceId,
      issueType: "notion_schema_type_mismatch",
      severity: "warning",
      humanSummary: `Notion Mailroom has ${diff.typeMismatches.length} property type mismatch(es) that need a manual decision`,
      objectType: "notion_workspace_database",
      objectId: "mailroom_conversations",
      retryable: false,
      technicalDetail: JSON.stringify(diff.typeMismatches),
    });
  }

  if (patchedNames.length === 0 || dryRun) {
    await emitDiagnosticEvent({
      traceId,
      module: "notion",
      stage: "migrate_mailroom_schema",
      eventType: dryRun ? "schema_migration_planned" : "schema_already_in_sync",
      status: "success",
      humanSummary: dryRun
        ? `Mailroom schema migration plan: ${patchedNames.length} propert(ies) would change`
        : "Notion Mailroom schema already matches the expected contract",
      metadata: { patchedNames, diff },
    });
    return baseReport;
  }

  try {
    await notionClient.dataSources.update({
      data_source_id: dataSourceId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties: patch as any,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Notion error";
    await emitDiagnosticEvent({
      traceId,
      module: "notion",
      stage: "migrate_mailroom_schema",
      eventType: "schema_patch_failed",
      status: "failure",
      severity: "error",
      objectType: "notion_workspace_database",
      objectId: "mailroom_conversations",
      humanSummary: "Notion rejected the Mailroom schema patch",
      technicalDetail: message,
    });
    await recordIssue({
      traceId,
      issueType: "notion_schema_patch_failed",
      severity: "error",
      humanSummary: "Notion rejected the Mailroom schema patch",
      objectType: "notion_workspace_database",
      objectId: "mailroom_conversations",
      retryable: true,
      technicalDetail: message,
    });
    return { ...baseReport, error: `Notion rejected the schema patch: ${message}` };
  }

  // Read back rather than assume the write landed.
  let after: ActualSchema = before;
  let readBackError: string | null = null;
  try {
    const live = await notionClient.dataSources.retrieve({ data_source_id: dataSourceId });
    after = (live as unknown as { properties: ActualSchema }).properties;
  } catch (error) {
    readBackError = error instanceof Error ? error.message : "Unknown Notion error";
  }

  const residual = diffDataSourceSchema(expected, after);

  await emitDiagnosticEvent({
    traceId,
    module: "notion",
    stage: "migrate_mailroom_schema",
    eventType: "schema_patched",
    status: residual.inSync ? "success" : "failure",
    severity: residual.inSync ? undefined : "error",
    objectType: "notion_workspace_database",
    objectId: "mailroom_conversations",
    humanSummary: `Patched ${patchedNames.length} Notion Mailroom propert(ies)`,
    metadata: { patchedNames, residual },
  });

  return {
    ...baseReport,
    actualPropertiesAfter: snapshot(after),
    legacyPropertiesRetained: describeLegacy(residual.legacyProperties),
    error:
      readBackError !== null
        ? `Schema patch was sent but could not be verified: ${readBackError}`
        : residual.inSync
          ? null
          : `Schema patch did not fully apply; still missing: ${residual.missingProperties.join(", ") || "(select options)"}`,
  };
}
