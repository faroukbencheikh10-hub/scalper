import { NextResponse } from "next/server";
import { runScalper } from "@/lib/server/runScalper";
export const dynamic="force-dynamic";
export async function POST(){ try{return NextResponse.json(await runScalper());}catch(err){return NextResponse.json({ok:false,error:err instanceof Error?err.message:String(err)},{status:500});} }
