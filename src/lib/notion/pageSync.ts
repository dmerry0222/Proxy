import "server-only";

import { emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import { notionClient } from "./client";
import { computeCanonicalHash, ensureSurfaceMapping, getSurfaceMapping, markPushed, markSyncError } from "./mapping";
import { resolveGuardedProperties, type ComparableValue } from "./guardedProperties";
import type { SurfaceObjectType } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reduces a Notion property to a single comparable scalar, so "did a human
 * change this?" is one equality check. Only the property types that can be
 * guarded are handled; anything else compares as null and is therefore
 * never treated as overridden.
 */
export function comparableValue(property: any): ComparableValue {
  if (!property) return null;
  switch (property.type) {
    case "select":
      return property.select?.name ?? null;
    case "checkbox":
      return property.checkbox === true;
    case "rich_text":
      return (property.rich_text ?? []).map((chunk: any) => chunk?.plain_text ?? "").join("") || null;
    case "date":
      return property.date?.start ?? null;
    default:
      return null;
  }
}

/**
 * The value Proxy is about to write, in the same comparable form, taken
 * from the payload it built rather than from canonical fields -- so the
 * baseline always reflects exactly what Notion received.
 */
function proposedComparableValues(properties: Record<string, unknown>, guarded: string[]): Record<string, ComparableValue> {
  const values: Record<string, ComparableValue> = {};
  for (const name of guarded) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) {
      values[name] = comparableValue(properties[name]);
    }
  }
  return values;
}

const GUARDED_BASELINE_KEY = "guardedBaseline";

function readBaseline(metadata: Record<string, unknown>): Record<string, ComparableValue> {
  const stored = metadata?.[GUARDED_BASELINE_KEY];
  return stored && typeof stored === "object" ? (stored as Record<string, ComparableValue>) : {};
}

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
  /**
   * Properties Proxy proposes but a human may override in Notion. When the
   * live page differs from what Proxy last wrote, that property is left
   * untouched instead of being overwritten. See guardedProperties.ts.
   */
  guardedProperties?: string[];
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
      const properties = params.buildProperties();
      const guarded = params.guardedProperties ?? [];

      let payload = properties;
      let metadata: Record<string, unknown> | undefined;

      if (guarded.length > 0) {
        /*
         * Read the live page before writing. This costs one extra Notion
         * call, but only on pages that are actually changing -- the
         * canonical-hash skip above already returned for everything else,
         * so a steady-state sweep adds no calls at all.
         */
        const live: any = await notionClient.pages.retrieve({ page_id: mapping.externalObjectId });
        const liveValues: Record<string, ComparableValue> = {};
        for (const name of guarded) {
          liveValues[name] = comparableValue(live.properties?.[name]);
        }

        const resolution = resolveGuardedProperties({
          properties,
          guarded,
          liveValues,
          baseline: readBaseline(mapping.metadata),
          proposedValues: proposedComparableValues(properties, guarded),
        });

        payload = resolution.payload;
        metadata = { ...mapping.metadata, [GUARDED_BASELINE_KEY]: resolution.nextBaseline };

        if (resolution.overridden.length > 0) {
          await emitDiagnosticEvent({
            traceId: params.traceId,
            module: "notion",
            stage: `sync_${params.objectType}`,
            eventType: "human_override_preserved",
            status: "success",
            objectType: params.objectType,
            objectId: params.objectId,
            humanSummary: `Preserved human edit(s) in Notion: ${resolution.overridden.join(", ")}`,
            metadata: { overridden: resolution.overridden },
          });
        }
      }

      await notionClient.pages.update({
        page_id: mapping.externalObjectId,
        properties: payload as any,
      });
      await markPushed(mapping.id, { externalObjectId: mapping.externalObjectId, canonicalHash, metadata });
      return "updated";
    }

    if (!params.dataSourceId) {
      throw new Error(`No data source id available to create ${params.objectType} ${params.objectId}`);
    }

    const createProperties = { ...params.buildProperties(), ...(params.buildCreateOnlyProperties?.() ?? {}) };

    const page = await notionClient.pages.create({
      parent: { type: "data_source_id", data_source_id: params.dataSourceId },
      properties: createProperties as any,
      children: params.buildChildren?.() as any,
    });

    /*
     * Record the baseline at creation, not just on update: a human can edit
     * a guarded property between the page appearing and the first update,
     * and without a baseline that edit would read as agreement and be
     * overwritten.
     */
    const guardedOnCreate = params.guardedProperties ?? [];
    await markPushed(mapping.id, {
      externalObjectId: page.id,
      canonicalHash,
      metadata:
        guardedOnCreate.length > 0
          ? { ...mapping.metadata, [GUARDED_BASELINE_KEY]: proposedComparableValues(createProperties, guardedOnCreate) }
          : undefined,
    });
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
