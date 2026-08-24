import MailroomReview from "@/components/mailroom/MailroomReview";
import { loadLatestMailroomRun } from "@/lib/mailroom/loadLatestMailroomRun";

export default async function MailroomPage() {
  const { runId, conversations } =
    await loadLatestMailroomRun();

  return (
    <MailroomReview
      initialConversations={conversations}
      runId={runId}
    />
  );
}