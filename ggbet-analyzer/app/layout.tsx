import type { Metadata } from "next";
import { C } from "@/lib/theme";

export const metadata: Metadata = {
  title: "GGBetAnalyzer — eBasketball H2H GG League",
  description: "NBA 2K H2H GG League betting analytics: walk-forward backtesting, line shopping, CLV tracking.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, padding: 0, background: C.bg }}>
        {children}
      </body>
    </html>
  );
}
