import MemoryReview from "@/components/memory/MemoryReview";
import { loadMemoryReviewItems } from "@/lib/memory/loadReviewItems";

/*
 * The review queue is per-request state that changes every time Dave acts
 * on an item. Without this, Next prerenders the page at BUILD time and
 * serves that frozen snapshot forever: already-resolved items keep
 * reappearing as the active card, and the RPC then correctly refuses them
 * with "already resolved or dismissed". /execute, /ingestion, and
 * /inspector-general already declare this; these Memory pages were the
 * only data-backed ones that did not.
 */
export const dynamic = "force-dynamic";

export default async function MemoryReviewPage() {
  const items = await loadMemoryReviewItems();

  return <MemoryReview initialItems={items} />;
}