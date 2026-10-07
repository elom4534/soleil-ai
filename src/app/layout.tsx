import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { THEME_INIT_SCRIPT } from "@/components/ui/ThemeToggle";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: {
    default: `${APP_NAME} — ${APP_TAGLINE}`,
    template: `%s · ${APP_NAME}`,
  },
  description:
    "SOLEIL analyse automatiquement les matchs de football et calcule des probabilités " +
    "calibrées : résultat, buts, Over/Under, mi-temps, BTTS et score exact. " +
    "SOLEIL ne promet pas de connaître le futur, il calcule les probabilités du futur.",
  applicationName: APP_NAME,
  keywords: ["football", "prédiction", "probabilités", "statistiques", "analyse", "xG"],
  openGraph: {
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description: "Analysez. Comprenez. Anticipez.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6ebf4" },
    { media: "(prefers-color-scheme: dark)", color: "#232b37" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <a
          href="#contenu"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-fg focus:px-3 focus:py-2 focus:text-bg"
        >
          Aller au contenu
        </a>
        <AppShell user={null}>
          <div id="contenu">{children}</div>
        </AppShell>
      </body>
    </html>
  );
}
