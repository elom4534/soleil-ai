/**
 * ============================================================================
 * SOLEIL — Phase 16 · §27 · Expressions de planification
 * ============================================================================
 * La machine ne possède **aucun démon `cron`** (`crontab` absent, vérifié en
 * audit). Plutôt que d'exiger un outil qui n'existe pas, la planification est
 * portée par l'application : ces expressions sont évaluées par le code, ce qui
 * les rend testables et vérifiables.
 *
 * Format accepté — le classique à cinq champs, en UTC :
 *
 *      minute   heure   jour-du-mois   mois   jour-de-semaine
 *      ──────   ─────   ────────────   ────   ────────────────
 *      0-59     0-23    1-31           1-12   0-6 (0 = dimanche)
 *
 * Chaque champ accepte `*`, une valeur (`6`), une liste (`1,13`), un intervalle
 * (`9-17`) et un pas (`*​/6`, `1-30/2`). Le format « 5 champs » est le seul
 * accepté : une expression plus riche (secondes, `@daily`, alias) est refusée
 * explicitement plutôt qu'interprétée de travers.
 *
 * Ce module est **pur** : aucune base, aucune horloge implicite. `nextRun`
 * reçoit toujours l'instant de départ, ce qui rend les tests déterministes.
 */

const FIELDS = ["minute", "heure", "jour-du-mois", "mois", "jour-de-semaine"] as const;
export type CronField = (typeof FIELDS)[number];

const RANGES: Record<CronField, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  heure: { min: 0, max: 23 },
  "jour-du-mois": { min: 1, max: 31 },
  mois: { min: 1, max: 12 },
  "jour-de-semaine": { min: 0, max: 6 },
};

export class CronSyntaxError extends Error {}

/** Développe un champ en liste de valeurs autorisées, triées et dédupliquées. */
export function parseField(field: CronField, raw: string): number[] {
  const { min, max } = RANGES[field];
  const spec = raw.trim();
  if (spec === "") throw new CronSyntaxError(`Champ ${field} vide.`);
  if (spec === "*") return range(min, max);

  const values = new Set<number>();

  for (const part of spec.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronSyntaxError(`Pas invalide dans ${field} : « ${part} ».`);
    }

    let from = min;
    let to = max;
    if (rangePart !== "*" && rangePart !== "") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map((v) => Number(v.trim()));
        if (!Number.isInteger(a) || !Number.isInteger(b)) {
          throw new CronSyntaxError(`Intervalle invalide dans ${field} : « ${part} ».`);
        }
        from = a;
        to = b;
      } else {
        const single = Number(rangePart.trim());
        if (!Number.isInteger(single)) {
          throw new CronSyntaxError(`Valeur invalide dans ${field} : « ${part} ».`);
        }
        from = single;
        to = single;
      }
    }

    if (from < min || to > max || from > to) {
      throw new CronSyntaxError(`Valeur hors bornes dans ${field} : « ${part} » (attendu ${min}-${max}).`);
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export interface CronExpression {
  raw: string;
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** Vrai si `jour-du-mois` ou `jour-de-semaine` est restreint. */
  restrictedDays: boolean;
}

export function parseCron(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronSyntaxError(
      `Expression « ${expr} » : 5 champs attendus (minute heure jour-du-mois mois jour-de-semaine).`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
    parseField(FIELDS[index]!, part),
  );

  return {
    raw: expr.trim(),
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek: dayOfWeek!,
    restrictedDays: parts[2] !== "*" || parts[4] !== "*",
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prochain déclenchement **strictement postérieur** à `from`.
 *
 * Renvoie `null` si aucun déclenchement n'existe dans l'horizon couvert
 * (400 jours) — cas d'une expression impossible comme `0 0 31 2 *`.
 * Le calcul reste une recherche minute par minute : coûteuse en théorie,
 * négligeable en pratique, et surtout **lisible** (une seule boucle, aucune
 * arithmétique de calendrier subtile à relire).
 */
export function nextRun(expr: CronExpression | string, from: Date): Date | null {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  const minutes = new Set(cron.minute);
  const hours = new Set(cron.hour);
  const days = new Set(cron.dayOfMonth);
  const months = new Set(cron.month);
  const weekdays = new Set(cron.dayOfWeek);

  // On démarre à la minute suivante, tronquée (les secondes n'existent pas ici).
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = cursor.getTime() + 400 * 86_400_000;

  while (cursor.getTime() < limit) {
    const minute = cursor.getUTCMinutes();
    const hour = cursor.getUTCHours();
    const dayOfMonth = cursor.getUTCDate();
    const month = cursor.getUTCMonth() + 1;
    const dayOfWeek = cursor.getUTCDay();

    if (months.has(month) && hours.has(hour) && minutes.has(minute)) {
      // Règle cron classique : quand les deux champs « jour » sont restreints,
      // le déclenchement a lieu si l'un OU l'autre correspond.
      const domMatch = days.has(dayOfMonth);
      const dowMatch = weekdays.has(dayOfWeek);
      const dayMatch = cron.restrictedDays
        ? (days.size < 31 && domMatch) || (weekdays.size < 7 && dowMatch)
        : true;
      if (dayMatch) return cursor;
    }

    cursor.setTime(cursor.getTime() + 60_000);
  }

  return null;
}

/** Description lisible, pour l'affichage d'administration. */
export function describeCron(expr: string): string {
  let cron: CronExpression;
  try {
    cron = parseCron(expr);
  } catch {
    return `Expression invalide : ${expr}`;
  }

  const pad = (values: number[]) => values.map((v) => String(v).padStart(2, "0")).join(", ");

  if (cron.minute.length === 1 && cron.hour.length > 0 && cron.hour.length < 24) {
    const hours = cron.hour.map((h) => `${String(h).padStart(2, "0")}:${pad(cron.minute).slice(0, 2)}`);
    const days =
      cron.restrictedDays && (cron.dayOfMonth.length < 31 || cron.dayOfWeek.length < 7)
        ? " (certains jours)"
        : "";
    return `chaque jour à ${hours.join(", ")} UTC${days}`;
  }

  if (cron.minute.length === 1 && cron.hour.length === 1) {
    return `chaque jour à ${String(cron.hour[0]).padStart(2, "0")}:${String(cron.minute[0]).padStart(2, "0")} UTC`;
  }

  return `minutes ${pad(cron.minute)} · heures ${pad(cron.hour)} (UTC)`;
}
