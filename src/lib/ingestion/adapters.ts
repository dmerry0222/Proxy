import type {
  IngestionInput,
} from "@/lib/ingestion/types";

/*
 * Every future provider adapter ends at this contract. Provider-specific
 * authentication and payload handling stay outside the canonical pipeline.
 */
export interface ArtifactAdapter<TPayload = unknown> {
  readonly sourceSystem: string;
  canHandle(payload: TPayload): boolean;
  toIngestionInput(payload: TPayload): Promise<IngestionInput>;
}

export class AdapterRegistry {
  private readonly adapters =
    new Map<string, ArtifactAdapter>();

  register(adapter: ArtifactAdapter) {
    this.adapters.set(
      adapter.sourceSystem,
      adapter
    );
  }

  get(sourceSystem: string) {
    return this.adapters.get(
      sourceSystem
    ) ?? null;
  }

  list() {
    return [
      ...this.adapters.keys(),
    ];
  }
}

export const artifactAdapters =
  new AdapterRegistry();

/*
 * Stubs to implement without changing the downstream pipeline:
 * - FathomAdapter
 * - TeamsTranscriptAdapter
 * - ZoomAdapter
 * - PlaudAdapter
 * - DropboxAdapter
 * - OneDriveAdapter
 * - ForwardedEmailAttachmentAdapter
 */
