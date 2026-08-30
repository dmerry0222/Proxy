import InspectorGeneralDashboard from "@/components/inspector-general/InspectorGeneralDashboard";
import { loadInspectorGeneralOverview } from "@/lib/diagnostics/loadOverview";

export const dynamic = "force-dynamic";

export default async function InspectorGeneralPage() {
  const overview = await loadInspectorGeneralOverview();

  return <InspectorGeneralDashboard initialOverview={overview} />;
}
