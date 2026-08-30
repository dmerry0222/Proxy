import "server-only";

import { emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import { notionClient } from "./client";
import { computeCanonicalHash, ensureSurfaceMapping, getSurfaceMapping, markPushed, markSyncError } from "./mapping";
import type { SurfaceObjectType } from "./types";

export function titleProperty(text: string) {
  return { type: "title" as const, title: [{ type: "text" as const, text: { content: text.slice(0, 2000) } }] };
}

export function richTextProperty(text: string | null | undefined) {
  return {
    type: "rich_text" as const,
    rich_text: text ? [{ type: "text" as const, text: { content: text.slice(0, 2000) } }] : [],
  };
}

export function selectProperty(name: string | null | undefined) {
  return { type: "select" as const, select: name ? { name } : null };
}

export function checkboxProperty(value: boolean) {
  return { type: "checkbox" as const, checkbox: value };
}

export function dateProperty(iso: string | null | undefined) {
  return { type: "date" as const, date: iso ? { start: iso } : null };
}

export function numberProperty(value: number | null | undefined) {
  return { type: "number" as const, number: value ?? null };
}

export function relationProperty(pageId: string | null | undefined) {
  return { type: "relation" as const, relation: pageId ? [{ id: pageId }] : [] };
}

export type ObjectAction = "created" | "updated" | "skipped" | "would_create" | "would_update" | "error";

export type ObjectSyncCounts = Record<ObjectAction, number>;

export function emptyCounts(): ObjectSyncCounts {
  return { created: 0, updated: 0, skipped: 0, would_create: 0, would_update: 0, error: 0 };
}

export type SyncError = { objectType: SurfaceObjectType; objectId: string; message: string };

/**
 * Applies (or, in dry run, only plans) one object's projection into a
 * Notion data source. Read-only in dry run: it never inserts a
 * surface_objects row or calls Notion, so a dry run has zero side effects.
 *
 * `buildCreateOnlyProperties` is for fields Proxy has no canonical opinion
 * about (a human-owned status field, a reply-edit box, etc.) -- they're set
 * once on first creation and then never touched again by this function, so
 * a later re-push (triggered by an unrelated canonical field changing)
 * can't clobber whatever a human has since typed into them in Notion.
 */
export async function syncOne(params: {
  dryRun: boolean;
  traceId: string | null;
  objectType: SurfaceObjectType;
  objectId: string;
  dataSourceId: string | null;
  canonicalFields: Record<string, unknown>;
  buildProperties: () => Record<string, unknown>;
  buildCreateOnlyProperties?: () => Record<string, unknown>;
  buildChildren?: () => unknown[] | undefined;
}): Promise<ObjectAction> {
  const canonicalHash = computeCanonicalHash(params.canonicalFields);
  const existing = await getSurfaceMapping(params.objectType, params.objectId);

  if (existing?.externalObjectId && existing.canonicalHash === canonicalHash) {
    return "skipped";
  }

  if (params.dryRun) {
    return existing?.externalObjectId ? "would_update" : "would_create";
  }

  const mapping = existing ?? (await ensureSurfaceMapping(params.objectType, params.objectId));

  try {
    if (mapping.externalObjectId) {
      await notionClient.pages.update({
        page_id: mapping.externalObjectId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: params.buildProperties() as any,
      });
      await markPushed(mapping.id, { externalObjectId: mapping.externalObjectId, canonicalHash });
      return "updated";
    }

    if (!params.dataSourceId) {
      throw new Error(`No data source id available to create ${params.objectType} ${params.objectId}`);
    }

    const properties = { ...params.buildProperties(), ...(params.buildCreateOnlyProperties?.() ?? {}) };

    const page = await notionClient.pages.create({
      parent: { type: "data_source_id", data_source_id: params.dataSourceId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties: properties as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      children: params.buildChildren?.() as any,
    });
    await markPushed(mapping.id, { externalObjectId: page.id, canonicalHash });
    return "created";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await markSyncError(mapping.id, message);
    await emitDiagnosticEvent({
      traceId: params.traceId,
      module: "notion",
      stage: `sync_${params.objectType}`,
      eventType: "object_push_failed",
      status: "failure",
      severity: "error",
      objectType: params.objectType,
      objectId: params.objectId,
      humanSummary: `Failed to push ${params.objectType} ${params.objectId} to Notion`,
      technicalDetail: message,
    });
    await recordIssue({
      traceId: params.traceId,
      issueType: "notion_sync_failed",
      severity: "error",
      humanSummary: `Notion push failed for ${params.objectType} ${params.objectId}`,
      objectType: params.objectType,
      objectId: params.objectId,
      retryable: true,
      technicalDetail: message,
    });
    return "error";
  }
}
