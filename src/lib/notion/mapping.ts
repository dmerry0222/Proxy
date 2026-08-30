import "server-only";

import { createHash } from "node:crypto";

import { supabaseServer } from "@/lib/supabase/server";
import type { SurfaceObjectRecord, SurfaceObjectType, SurfaceSyncStatus } from "./types";

type SurfaceObjectRow = {
  id: string;
  surface_type: "notion";
  object_type: string;
  proxy_object_id: string;
  external_object_id: string | null;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  last_external_updated_at: string | null;
  sync_status: SurfaceSyncStatus;
  sync_error: string | null;
  canonical_hash: string | null;
  metadata: Record<string, unknown>;
};

function toRecord(row: SurfaceObjectRow): SurfaceObjectRecord {
  return {
    id: row.id,
    surfaceType: row.surface_type,
    objectType: row.object_type as SurfaceObjectType,
    proxyObjectId: row.proxy_object_id,
    externalObjectId: row.external_object_id,
    lastPushedAt: row.last_pushed_at,
    lastPulledAt: row.last_pulled_at,
    lastExternalUpdatedAt: row.last_external_updated_at,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    canonicalHash: row.canonical_hash,
    metadata: row.metadata ?? {},
  };
}

/**
 * Stable hash of a projected object's canonical fields, used to skip
 * pushing to Notion when nothing has actually changed since the last sync.
 * Key order in `value` must be deterministic -- callers should build it
 * with a fixed field order, not spread arbitrary objects into it.
 */
export function computeCanonicalHash(value: Record<string, unknown>): string {
  const json = JSON.stringify(value, Object.keys(value).sort());
  return createHash("sha256").update(json).digest("hex");
}

export async function getSurfaceMapping(
  objectType: SurfaceObjectType,
  proxyObjectId: string
): Promise<SurfaceObjectRecord | null> {
  const { data, error } = await supabaseServer
    .from("surface_objects")
    .select("*")
    .eq("surface_type", "notion")
    .eq("object_type", objectType)
    .eq("proxy_object_id", proxyObjectId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load surface mapping for ${objectType}:${proxyObjectId}: ${error.message}`);
  }

  return data ? toRecord(data as SurfaceObjectRow) : null;
}

export async function getSurfaceMappingByExternalId(
  objectType: SurfaceObjectType,
  externalObjectId: string
): Promise<SurfaceObjectRecord | null> {
  const { data, error } = await supabaseServer
    .from("surface_objects")
    .select("*")
    .eq("surface_type", "notion")
    .eq("object_type", objectType)
    .eq("external_object_id", externalObjectId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load surface mapping for external id ${externalObjectId}: ${error.message}`);
  }

  return data ? toRecord(data as SurfaceObjectRow) : null;
}

/**
 * Creates the mapping row for a proxy object the first time it's projected,
 * or returns the existing one. Does not touch external_object_id -- callers
 * set that via markPushed once the Notion page/database actually exists.
 */
export async function ensureSurfaceMapping(
  objectType: SurfaceObjectType,
  proxyObjectId: string
): Promise<SurfaceObjectRecord> {
  const existing = await getSurfaceMapping(objectType, proxyObjectId);
  if (existing) {
    return existing;
  }

  const { data, error } = await supabaseServer
    .from("surface_objects")
    .insert({
      surface_type: "notion",
      object_type: objectType,
      proxy_object_id: proxyObjectId,
      sync_status: "pending",
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to create surface mapping for ${objectType}:${proxyObjectId}: ${error.message}`);
  }

  return toRecord(data as SurfaceObjectRow);
}

export async function markPushed(
  mappingId: string,
  params: {
    externalObjectId: string;
    canonicalHash: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabaseServer
    .from("surface_objects")
    .update({
      external_object_id: params.externalObjectId,
      canonical_hash: params.canonicalHash,
      sync_status: "synced",
      sync_error: null,
      last_pushed_at: new Date().toISOString(),
      ...(params.metadata ? { metadata: params.metadata } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", mappingId);

  if (error) {
    throw new Error(`Failed to mark surface mapping ${mappingId} pushed: ${error.message}`);
  }
}

export async function markSyncError(mappingId: string, message: string): Promise<void> {
  const { error } = await supabaseServer
    .from("surface_objects")
    .update({
      sync_status: "error",
      sync_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", mappingId);

  if (error) {
    throw new Error(`Failed to mark surface mapping ${mappingId} errored: ${error.message}`);
  }
}
