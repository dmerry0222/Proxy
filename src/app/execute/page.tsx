import ExecuteDashboard from "@/components/execute/ExecuteDashboard";
import { loadExecuteDashboard } from "@/lib/execute/loadDashboard";
import { loadReconciliationReview } from "@/lib/execute/loadReconciliationReview";
import { ensureOverdueExternalAttention } from "@/lib/execute/overdueExternal";

export const dynamic = "force-dynamic";

export default async function ExecutePage() {
  await ensureOverdueExternalAttention().catch((error) => {
    console.error("Could not check overdue external work:", error);
  });
  const [dashboard, review] = await Promise.all([loadExecuteDashboard(), loadReconciliationReview()]);
  return <ExecuteDashboard initialDashboard={dashboard} reviewEntries={review.entries} />;
}
