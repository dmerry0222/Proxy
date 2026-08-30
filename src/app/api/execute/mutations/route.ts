import { NextResponse } from "next/server";

import { applyExecuteMutation } from "@/lib/execute/mutateExecute";

export async function POST(request: Request) {
  try {
    const result = await applyExecuteMutation(await request.json());
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Execute error";
    const status = /required|valid|must|cannot|overlap|Only items/.test(message) ? 400 : 500;
    console.error("Execute mutation failed:", error);
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

