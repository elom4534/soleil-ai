/**
 * ============================================================================
 * SOLEIL AI — Recherche web (source externe, gratuite, sourcée)
 * ============================================================================
 * Utilisée UNIQUEMENT quand les données internes ne suffisent pas (actualités,
 * blessures, composition, entraîneur…). Deux voies sans clé d'API :
 *
 *   1. DuckDuckGo Instant Answer (JSON, public) ;
 *   2. DuckDuckGo HTML (résultats web) en secours.
 *
 * Tout résultat est marqué `web` et porte son URL : l'utilisateur doit
 * pouvoir vérifier. Un échec réseau ne casse jamais une réponse — l'agent
 * déclare « source web indisponible » (§16 : ne jamais inventer).
 *
 * 🔒 Aucun secret, aucun appel payant, temps limité (5 s), au plus 2
 *    recherches par question (appliqué par l'orchestrateur).
 */

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

const TIMEOUT_MS = 5_000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SoleilAI/1.0 (research assistant; contact: operator)" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

/**
 * Recherche web. Renvoie `null` si la source est indisponible (l'agent le
 * dira explicitement), jamais des résultats inventés.
 */
export async function webSearch(query: string, limit = 4): Promise<WebHit[] | null> {
  // 1. Instant Answer
  const ia = await fetchText(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (ia) {
    try {
      const j = JSON.parse(ia) as { AbstractText?: string; AbstractURL?: string; Heading?: string; RelatedTopics?: { Text?: string; FirstURL?: string }[] };
      const hits: WebHit[] = [];
      if (j.AbstractText && j.AbstractURL) {
        hits.push({ title: j.Heading || query, url: j.AbstractURL, snippet: j.AbstractText.slice(0, 300) });
      }
      for (const r of j.RelatedTopics ?? []) {
        if (hits.length >= limit) break;
        if (r.Text && r.FirstURL) hits.push({ title: r.Text.slice(0, 100), url: r.FirstURL, snippet: r.Text.slice(0, 300) });
      }
      if (hits.length > 0) return hits.slice(0, limit);
    } catch {
      /* on passe au secours HTML */
    }
  }

  // 2. Résultats HTML (secours)
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!html) return null;
  const hits: WebHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hits.length < limit) {
    const raw = m[1];
    const url = raw.startsWith("//duckduckgo.com/l/?uddg=")
      ? decodeURIComponent(raw.split("uddg=")[1]?.split("&")[0] ?? raw)
      : raw;
    hits.push({
      title: decodeHtml(m[2].replace(/<[^>]+>/g, "")).trim().slice(0, 120),
      url,
      snippet: decodeHtml(m[3].replace(/<[^>]+>/g, "")).trim().slice(0, 300),
    });
  }
  return hits.length > 0 ? hits : null;
}
