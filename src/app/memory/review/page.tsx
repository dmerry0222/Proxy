import MemoryReview from "@/components/memory/MemoryReview";
import { loadMemoryReviewItems } from "@/lib/memory/loadReviewItems";

export default async function MemoryReviewPage() {
  const items = await loadMemoryReviewItems();

  return <MemoryReview initialItems={items} />;
}