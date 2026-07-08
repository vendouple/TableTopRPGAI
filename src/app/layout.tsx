import type { Metadata, Viewport } from "next";
import { Cinzel, Cormorant_Garamond, Manrope } from "next/font/google";
import "./globals.css";

const display = Cinzel({ subsets: ["latin"], weight: ["500", "700", "900"], variable: "--font-display" });
const serif = Cormorant_Garamond({ subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"], variable: "--font-serif" });
const ui = Manrope({ subsets: ["latin"], weight: ["400", "600", "800"], variable: "--font-ui" });

export const metadata: Metadata = {
  title: "Mythweaver — the AI game table",
  description: "A LAN-hosted AI game master. The screen is the stage, your phones are the hands of fate."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#05070d"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${ui.variable}`}>
      <body>{children}</body>
    </html>
  );
}
