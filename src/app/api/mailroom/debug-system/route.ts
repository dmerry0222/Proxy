import { NextResponse } from "next/server";

import { loadMailroomConversations } from "@/lib/mailroom/loadMailroom";

export async function GET() {
  const conversations =
    await loadMailroomConversations();

  return NextResponse.json(
    conversations.map((conversation) => ({
      subject: conversation.subject,
      sender: conversation.senderEmail,
      systemType:
        conversation.systemType ?? null,

      messages: conversation.messages.map(
        (message) => ({
          subject: message.subject,
          sender: message.fromEmail,
          folder: message.folder,
        })
      ),
    }))
  );
}   