import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
export const metadata:Metadata={title:"Scalper — XAUUSD",description:"Scalper puro XAUUSD M1/M5"};
export default function Layout({children}:{children:ReactNode}){return <html lang="it"><body>{children}</body></html>}
