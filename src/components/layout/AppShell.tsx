"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Home,
  Goal,
  Flame,
  BarChart3,
  Sparkles,
  TrendingUp,
  Settings,
  Shield,
  Menu,
  X,
  Search,
  Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SoleilWordmark } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  /** Affiché dans la barre basse mobile (max 5). */
  mobile?: boolean;
  adminOnly?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Accueil", icon: Home, mobile: true },
  { href: "/matchs", label: "Matchs", icon: Goal, mobile: true },
  { href: "/top-picks", label: "Top Picks", icon: Flame, mobile: true },
  { href: "/ai", label: "Soleil AI", icon: Sparkles, mobile: true },
  { href: "/performance", label: "Performance", icon: TrendingUp, mobile: true },
  { href: "/analyses", label: "Analyses", icon: BarChart3 },
  // §11 — page interne : mémoire des erreurs, séparée de l'interface publique.
  { href: "/apprentissage", label: "Apprentissage", icon: Brain },
  { href: "/profil", label: "Profil", icon: Settings },
];

const ADMIN_ITEM: NavItem = {
  href: "/admin",
  label: "Administration",
  icon: Shield,
  adminOnly: true,
};

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; role?: string } | null;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const items = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN"
    ? [...NAV_ITEMS, ADMIN_ITEM]
    : NAV_ITEMS;
  const mobileItems = items.filter((i) => i.mobile || i.adminOnly).slice(0, 5);

  return (
    <div className="min-h-dvh">
      {/* ---------------- Barre latérale (desktop ≥ lg) ---------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border-subtle bg-bg-elevated lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/" aria-label="SOLEIL — accueil">
            <SoleilWordmark size={28} />
          </Link>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Navigation principale">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-colors",
                  active
                    ? "bg-soleil-500 text-white"
                    : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <Icon
                  className={cn("size-[18px]", active && "text-white")}
                  strokeWidth={active ? 2.3 : 1.9}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border-subtle p-3">
          <ThemeToggle />
          <div className="mt-3 px-1">
            {user ? (
              <Link
                href="/profil"
                className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-bg-subtle"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-soleil-400 to-soleil-600 text-[12px] font-semibold text-white">
                  {(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-fg">
                    {user.name ?? "Mon compte"}
                  </span>
                  <span className="block truncate text-[11px] text-fg-subtle">{user.email}</span>
                </span>
              </Link>
            ) : (
              <Link
                href="/connexion"
                className="block rounded-xl bg-soleil-500 px-3 py-2.5 text-center text-[13px] font-medium text-white transition-colors hover:bg-soleil-600"
              >
                Se connecter
              </Link>
            )}
          </div>
        </div>
      </aside>

      {/* ---------------- En-tête mobile ---------------- */}
      <header className="glass sticky top-0 z-30 border-b border-border-subtle lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/" aria-label="SOLEIL — accueil">
            <SoleilWordmark size={26} />
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/matchs"
              aria-label="Rechercher un match"
              className="grid size-9 place-items-center rounded-full text-fg-muted hover:bg-bg-subtle"
            >
              <Search className="size-[18px]" strokeWidth={1.9} />
            </Link>
            <ThemeToggle compact />
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Ouvrir le menu"
              className="grid size-9 place-items-center rounded-full text-fg-muted hover:bg-bg-subtle"
            >
              <Menu className="size-[19px]" strokeWidth={1.9} />
            </button>
          </div>
        </div>
      </header>

      {/* ---------------- Tiroir mobile ---------------- */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="animate-[rise_0.28s_cubic-bezier(0.16,1,0.3,1)_both] absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-3xl border-t border-border-subtle bg-bg-elevated p-4 pb-8">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold tracking-wide text-fg-muted uppercase">
                Navigation
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Fermer le menu"
                className="grid size-8 place-items-center rounded-full hover:bg-bg-subtle"
              >
                <X className="size-[18px]" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {items.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-3 text-[13.5px] font-medium",
                      active
                        ? "border-soleil-500 bg-soleil-500 text-white"
                        : "border-border-subtle text-fg-muted",
                    )}
                  >
                    <Icon className="size-[17px]" strokeWidth={1.9} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <div className="mt-4">
              {user ? (
                <Link
                  href="/profil"
                  onClick={() => setDrawerOpen(false)}
                  className="flex items-center gap-3 rounded-xl bg-bg-subtle px-3 py-3"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-soleil-400 to-soleil-600 text-[12px] font-semibold text-white">
                    {(user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="text-[13.5px] font-medium text-fg">
                    {user.name ?? user.email}
                  </span>
                </Link>
              ) : (
                <Link
                  href="/connexion"
                  onClick={() => setDrawerOpen(false)}
                  className="block rounded-xl bg-soleil-500 px-3 py-3 text-center text-[13.5px] font-medium text-white"
                >
                  Se connecter
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- Contenu (feuille blanche arrondie de la référence) ---------------- */}
      <div className="lg:pl-60">
        <main className="mx-auto my-2.5 w-full max-w-5xl rounded-2xl border border-border-subtle bg-bg-elevated px-4 pt-5 pb-28 sm:my-4 lg:px-8 lg:pt-8 lg:pb-12">
          {children}
        </main>
      </div>

      {/* ---------------- Navigation basse (mobile) ---------------- */}
      <nav
        className="glass pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle lg:hidden"
        aria-label="Navigation mobile"
      >
        <div className="flex items-stretch justify-around px-1">
          {mobileItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium transition-colors",
                  active ? "text-soleil-600 dark:text-soleil-400" : "text-fg-subtle",
                )}
              >
                <Icon className="size-[21px]" strokeWidth={active ? 2.3 : 1.8} />
                {item.label}
                {active ? (
                  <span className="absolute top-0 h-0.5 w-6 rounded-full bg-soleil-500" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
