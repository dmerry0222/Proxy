import { NextResponse } from "next/server";

import { analyzeMailroomConversation } from "@/lib/mailroom/analyzeMailroom";
import { loadMailroomConversations } from "@/lib/mailroom/loadMailroom";

export async function GET() {
  try {
    const conversations =
      await loadMailroomConversations();

    if (conversations.length === 0) {
      return NextResponse.json(
        {
          error: "No inbox conversations found",
        },
        {
          status: 404,
        }
      );
    }

    const conversation = conversations[0];

    const analysis =
      await analyzeMailroomConversation(conversation);

    return NextResponse.json({
      conversation: {
        subject: conversation.subject,
        sender:
          conversation.senderName ??
          conversation.senderEmail,
        messages: conversation.messages.length,
      },

      analysis,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown Mailroom analysis error",
      },
      {
        status: 500,
      }
    );
  }
}