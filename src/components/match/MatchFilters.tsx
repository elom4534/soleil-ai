import Link from "next/link";
import { cn } from "@/lib/utils";

interface League {
  id: string;
  name: string;
  matchCount: number;
}

/**
 * §9 à §12 — La liste publique ne présente que des rencontres À VENIR.
 * Les filtres de période sont donc tous tournés vers l'avenir : il n'existe
 * plus aucune entrée permettant d'afficher un match terminé comme s'il
 * s'agissait d'une prédiction.
 */
const PERIODS = [
  { value: "tout", label: "Tous à venir" },
  { value: "24h", label: "24 h" },
  { value: "48h", label: "48 h" },
  { value: "7j", label: "7 jours" },
  { value: "30j", label: "30 jours" },
];

const CONFIDENCE = [
  { value: "tout", label: "Toutes" },
  { value: "haute", label: "≥ 68" },
  { value: "tres-haute", label: "≥ 80" },
];

const MARKETS = [
  { value: "all", label: "Tous marchés" },
  { value: "result", label: "Résultat 1X2" },
  { value: "over25", label: "Over 2.5" },
  { value: "under25", label: "Under 2.5" },
  { value: "btts", label: "BTTS" },
];

/**
 * Filtres intelligents (§19) : navigation par URL, donc partageable,
 * indexable et compatible avec le bouton « précédent » du navigateur.
 */
export function MatchFilters({
  leagues,
  days = [],
  current,
}: {
  leagues: League[];
  /** Journées proposées : « Aujourd'hui », « Demain », puis le quantième (§18). */
  days?: { value: string; label: string }[];
  current: { [key: string]: string | string[] | undefined };
}) {
  const build = (patch: Record<string, string | undefined>) => {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...current, ...patch })) {
      if (typeof v === "string" && v !== "tout" && v !== "all" && k !== "page") {
        query[k] = v;
      }
    }
    return { pathname: "/matchs", query };
  };

  return (
    <div className="space-y-3">
      {days.length > 0 && (
        <FilterRow label="Journée">
          <Chip href={build({ jour: undefined })} active={!current.jour}>
            Toutes
          </Chip>
          {days.map((day) => (
            <Chip
              key={day.value}
              href={build({ jour: day.value })}
              active={current.jour === day.value}
            >
              {day.label}
            </Chip>
          ))}
        </FilterRow>
      )}

      <FilterRow label="Période">
        {PERIODS.map((p) => (
          <Chip
            key={p.value}
            href={build({ quand: p.value })}
            active={(current.quand ?? "tout") === p.value}
          >
            {p.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Confiance">
        {CONFIDENCE.map((c) => (
          <Chip
            key={c.value}
            href={build({ confiance: c.value })}
            active={(current.confiance ?? "tout") === c.value}
          >
            {c.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Marché">
        {MARKETS.map((m) => (
          <Chip
            key={m.value}
            href={build({ marche: m.value })}
            active={(current.marche ?? "all") === m.value}
          >
            {m.label}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Compétition">
        <Chip href={build({ ligue: undefined })} active={!current.ligue}>
          Toutes
        </Chip>
        {leagues.slice(0, 8).map((l) => (
          <Chip key={l.id} href={build({ ligue: l.id })} active={current.ligue === l.id}>
            {l.name}
          </Chip>
        ))}
      </FilterRow>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 pt-1.5 text-[11.5px] font-medium text-fg-subtle">{label}</span>
      <div className="no-scrollbar -mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1 pb-0.5">
        {children}
      </div>
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: { pathname: string; query: Record<string, string> };
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        "shrink-0 rounded-full border px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors",
        active
          ? "border-soleil-500/40 bg-soleil-500/12 text-soleil-700 dark:text-soleil-300"
          : "border-border-subtle text-fg-muted hover:border-border-strong hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
