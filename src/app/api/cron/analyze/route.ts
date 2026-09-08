import { NextRequest, NextResponse } from "next/server";
import { runScalper } from "@/lib/server/runScalper";
export const dynamic="force-dynamic";
export const maxDuration=60;
function authorized(req:NextRequest){const s=process.env.CRON_SECRET; return Boolean(s)&&(req.headers.get("x-cron-secret")===s||req.nextUrl.searchParams.get("secret")===s||req.headers.get("authorization")===`Bearer ${s}`);}
export async function GET(req:NextRequest){ if(!authorized(req))return NextResponse.json({error:"Non autorizzato"},{status:401}); try{return NextResponse.json(await runScalper());}catch(err){return NextResponse.json({ok:false,error:err instanceof Error?err.message:String(err)},{status:500});} }
