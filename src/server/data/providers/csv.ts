/**
 * Parser CSV minimaliste, sans dépendance externe.
 * Gère les guillemets, les séparateurs échappés et l'encodage UTF-8 avec BOM
 * (les fichiers football-data.co.uk commencent par un BOM).
 */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    if (cells.length < 3) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Convertit une cellule en nombre, ou `null` si absente/non numérique. */
export function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
