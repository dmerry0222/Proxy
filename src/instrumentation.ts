export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMemorySourceSyncListener } = await import(
      "@/lib/memory/sourceSyncRealtimeListener"
    );
    const { startNotionSyncScheduler } = await import(
      "@/lib/notion/notionSyncScheduler"
    );

    await startMemorySourceSyncListener();
    startNotionSyncScheduler();
  }
}
