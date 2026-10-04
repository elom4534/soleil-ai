"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { isUsableImageUrl, monogram, flagFor } from "@/lib/logos";

/**
 * ============================================================================
 * SOLEIL — §13 à §17 (Phase 15) · Visuels : logos, drapeaux, replis
 * ============================================================================
 * Priorité appliquée, dans l'ordre :
 *   1. logo fourni par la source de données (URL stockée en base) ;
 *   2. logo du cache local, s'il existe ;
 *   3. repli visuel : monogramme pour une équipe ou une compétition, drapeau
 *      pour un pays quand un code officiel est fourni.
 *
 * Aucune URL n'est construite ni devinée. Et si une image ne se charge pas
 * (lien devenu indisponible), on bascule sur le repli au lieu de laisser une
 * icône cassée : l'utilisateur ne voit jamais un carré vide.
 */

/** Logo d'équipe ou de compétition, avec repli automatique. */
export function EntityLogo({
  name,
  tla,
  logo,
  size = 28,
  className,
  rounded = "full",
}: {
  name: string;
  tla?: string | null;
  logo?: string | null;
  size?: number;
  className?: string;
  rounded?: "full" | "md";
}) {
  const [broken, setBroken] = useState(false);
  const usable = isUsableImageUrl(logo) && !broken;

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden bg-bg-subtle text-[10px] font-semibold text-fg-muted",
        rounded === "full" ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {usable ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        monogram(name, tla)
      )}
    </span>
  );
}

/**
 * Drapeau d'un pays, à partir du code officiel fourni par la source.
 * Aucun code → aucun drapeau : la mention du pays reste affichée, sans image
 * inventée.
 */
export function CountryFlag({
  countryCode,
  size = 12,
  className,
}: {
  countryCode?: string | null;
  size?: number;
  className?: string;
}) {
  const emoji = flagFor(countryCode);
  if (!emoji) return null;
  return (
    <span
      className={cn("leading-none", className)}
      style={{ fontSize: size }}
      role="img"
      aria-label={`Drapeau ${countryCode}`}
    >
      {emoji}
    </span>
  );
}

/** Compétition : logo, nom, pays et drapeau — ligne d'en-tête de carte. */
export function CompetitionLine({
  name,
  country,
  countryCode,
  logo,
  className,
}: {
  name: string;
  country?: string | null;
  countryCode?: string | null;
  logo?: string | null;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <EntityLogo name={name} logo={logo} size={16} rounded="md" />
      <span className="truncate font-medium text-fg-muted">{name}</span>
      {country ? (
        <span className="flex shrink-0 items-center gap-1 text-fg-subtle">
          <CountryFlag countryCode={countryCode} />
          <span className="hidden truncate sm:inline">{country}</span>
        </span>
      ) : null}
    </span>
  );
}
