import { NextRequest, NextResponse } from "next/server";
import { DASHBOARD_COOKIE, verifySessionCookie } from "@/lib/auth";

/**
 * Ritorna la risposta di errore da restituire, oppure null se la sessione e' valida.
 * Duplica il controllo del middleware: le route sensibili restano chiuse anche
 * se il middleware venisse aggirato o riconfigurato.
 */
export async function dashboardGuard(req: NextRequest) {
  const secret = process.env.DASHBOARD_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "DASHBOARD_SECRET mancante" }, { status: 503 });
  if (await verifySessionCookie(req.cookies.get(DASHBOARD_COOKIE)?.value, secret)) return null;
  return NextResponse.json({ ok: false, error: "Non autorizzato" }, { status: 401 });
}
