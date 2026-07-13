import { NextResponse } from "next/server";
import { getCampaign, recordHostHeartbeat, recordPlayerHeartbeat, isHostHeartbeatActive, deleteCampaign } from "@/lib/campaign/store";
import { serverLog, serverError } from "@/lib/aqua/chat";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const url = new URL(request.url);
  const isHost = url.searchParams.get("host") === "1";
  const playerId = url.searchParams.get("playerId") || "";

  if (isHost) {
    recordHostHeartbeat(params.id);
  }
  // Controllers pass their playerId so the server tracks presence (drives the
  // turn system's "skip absent players" and the reconnect UI).
  if (!isHost && playerId) {
    recordPlayerHeartbeat(params.id, playerId);
  }

  // hostActive lets controllers show "waiting for the screen" when the TV drops.
  return NextResponse.json({
    campaign: await getCampaign(params.id),
    hostActive: isHostHeartbeatActive(params.id)
  });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    serverLog("API campaigns [id]", `Request to delete campaign ID: ${params.id}`);
    await deleteCampaign(params.id);
    serverLog("API campaigns [id]", `Successfully deleted campaign ID: ${params.id}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    serverError("API campaigns [id]", `Failed to delete campaign ID: ${params.id}`, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete campaign" }, { status: 500 });
  }
}
