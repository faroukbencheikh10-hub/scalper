import { NextRequest, NextResponse } from "next/server";
import { runScalper } from "@/lib/server/runScalper";
import { dashboardGuard } from "@/lib/server/dashboardAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await dashboardGuard(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await runScalper());
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
