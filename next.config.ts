import type { NextConfig } from "next";

/**
 * Configuration Next.js de SOLEIL.
 * - En-têtes de sécurité appliqués à toutes les réponses (§30).
 * - Distants autorisés pour les logos d'équipes fournis par les sources.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Le rendu des pages dépend de données évolutives : pas de cache statique
  // agressif côté framework, le cache applicatif fait déjà ce travail.
  // `webpackMemoryOptimizations` + `cpus: 1` : build dans la mémoire disponible
  // (sandbox/AlwaysData) sans changer le comportement de l'application.
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns"],
    webpackMemoryOptimizations: true,
    workerThreads: false,
    cpus: 1,
  },

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "crests.football-data.org" },
      { protocol: "https", hostname: "r2.thesportsdb.com" },
      { protocol: "https", hostname: "media.api-sports.io" },
    ],
    formats: ["image/avif", "image/webp"],
  },

  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
