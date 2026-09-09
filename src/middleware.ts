import { NextRequest, NextResponse } from "next/server";
import { DASHBOARD_COOKIE, verifySessionCookie } from "@/lib/auth";

// Tutto protetto tranne /api/health, /api/login e gli asset statici di Next.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/login).*)"],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const secret = process.env.DASHBOARD_SECRET?.trim();

  // Mai fail-open: senza secret non si passa da nessuna parte.
  if (!secret) {
    return isApi
      ? NextResponse.json({ ok: false, error: "DASHBOARD_SECRET mancante" }, { status: 503 })
      : new NextResponse("DASHBOARD_SECRET mancante", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
  }

  if (pathname === "/login") return NextResponse.next();
  if (await verifySessionCookie(req.cookies.get(DASHBOARD_COOKIE)?.value, secret)) return NextResponse.next();

  if (isApi) return NextResponse.json({ ok: false, error: "Non autorizzato" }, { status: 401 });

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}
