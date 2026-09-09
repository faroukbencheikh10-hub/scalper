import { NextRequest, NextResponse } from "next/server";
import { DASHBOARD_COOKIE, SESSION_MAX_AGE_SEC, createSessionCookie, passwordMatches } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.DASHBOARD_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "DASHBOARD_SECRET mancante" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password || !(await passwordMatches(password, secret))) {
    return NextResponse.json({ ok: false, error: "Password non valida" }, { status: 401 });
  }

  const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const response = NextResponse.json({ ok: true, expiresAt: new Date(expiresAt).toISOString() });
  response.cookies.set({
    name: DASHBOARD_COOKIE,
    value: await createSessionCookie(secret, expiresAt),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return response;
}
