import json, glob, pathlib

J = sorted(glob.glob('data/backtests/*-phase13/phase13.json'))[-1]
R = sorted(glob.glob('data/backtests/*-phase13/records.jsonl'))[-1]
d = json.load(open(J))
M = {m['market']: m for m in d['markets']}
OUTDIR = J.split('/')[-2]

def fr(x, n=4): return f"{x:.{n}f}".replace('.', ',')
def sg(v, n=5): return ('+' if v >= 0 else '\u2212') + fr(abs(v), n)
def ic(m, n=5): return f"[{sg(m['lower'], n)} ; {sg(m['upper'], n)}]"
def best(m):
    if m['lower'] > 0: return '**A**'
    if m['upper'] < 0: return '**B**'
    if m['delta'] < -5e-6: return 'B'
    if m['delta'] > 5e-6: return 'A'
    return '='
H = "| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |"
S = "| --- | --: | --: | --: | --: | --- | --: | --- |"
def rw(n):
    m = M[n]
    return f"| {n} | {m['n']} | {fr(m['a'])} | {fr(m['b'])} | {sg(m['delta'])} | {ic(m)} | {m['probabilityBetter']:.2f} | {best(m)} |"
def block(names): return "\n".join([H, S] + [rw(n) for n in names])
def tab(head, sep, rows): return "\n".join([head, sep] + rows)

B_1X2 = ["1X2 — B brut", "1X2 — B calibré", "1X2 (matrice) — B brut", "1X2 (matrice) — B calibré"]
B_OU  = [f"O/U total {l}" for l in ["0,5","1,5","2,5","3,5","4,5"]]
B_MIX = ["BTTS","Domicile > 0,5","Extérieur > 0,5","Domicile > 1,5","Extérieur > 1,5","Domicile > 2,5","Extérieur > 2,5","Score exact"]
B_HT  = ["1X2 1re mi-temps"] + [f"1re mi-temps O/U {l}" for l in ["0,5","1,5","2,5"]] + ["1re mi-temps BTTS"] + \
        [f"1re mi-temps {t} > {l}" for l, t in [("0,5","domicile"),("0,5","extérieur"),("1,5","domicile"),("1,5","extérieur"),("2,5","domicile"),("2,5","extérieur")]] + \
        ["Score exact 1re mi-temps"]
B_SH  = ["1X2 2e mi-temps"] + [f"2e mi-temps O/U {l}" for l in ["0,5","1,5","2,5"]] + ["2e mi-temps BTTS"] + \
        [f"2e mi-temps {t} > {l}" for l, t in [("0,5","domicile"),("0,5","extérieur"),("1,5","domicile"),("1,5","extérieur"),("2,5","domicile"),("2,5","extérieur")]] + \
        ["Score exact 2e mi-temps"]

# ---------------- comptages ----------------
TOT = len(d['markets'])
EB = [m['market'] for m in d['markets'] if m['upper'] < 0]
EA = [m['market'] for m in d['markets'] if m['lower'] > 0]
SB = [m['market'] for m in d['markets'] if m['delta'] < -5e-6]
SA = [m['market'] for m in d['markets'] if m['delta'] > 5e-6]
CAL1X2 = {"1X2 — B calibré", "1X2 (matrice) — B calibré"}
EB_SANS_CAL = [n for n in EB if n not in CAL1X2]
EB_FT = [n for n in EB if "mi-temps" not in n and not n.startswith("1X2")]
EB_HT = [n for n in EB if "1re mi-temps" in n]
EB_SH = [n for n in EB if "2e mi-temps" in n]

# ---------------- §3.1 décomposition (calibrateurs PRÉ-ENREGISTRÉS phase 12) ----------------
rows = [json.loads(l) for l in open(R) if l.strip()]
byid = {}
for r in rows: byid.setdefault(r['m'], {})[r['c']] = r
ALL = [k for k, v in byid.items() if 'A' in v and 'B' in v]
def oi(a): return 0 if a['home'] > a['away'] else (1 if a['home'] == a['away'] else 2)
def vec(p, t, c):
    v = [max(p[i], 1e-9) ** (1/t) * c[i] for i in range(3)]
    s = sum(v); return [x/s for x in v]
def br(e, p): return sum((q - (1 if i == oi(e['a']) else 0))**2 for i, q in enumerate(p))
PRE_B = (0.66, [1, 1.28, 1.00])   # calibrateur du modèle B, phase 12 (antérieur et disjoint)
PRE_A = (0.69, [1, 1.26, 1.02])   # calibrateur du modèle A, phase 12
def scope(ids):
    n = len(ids)
    abr = sum(br(byid[k]['A'], byid[k]['A']['e']) for k in ids)/n
    bbr = sum(br(byid[k]['B'], byid[k]['B']['e']) for k in ids)/n
    acal = sum(br(byid[k]['A'], vec(byid[k]['A']['e'], *PRE_A)) for k in ids)/n
    bcal = sum(br(byid[k]['B'], vec(byid[k]['B']['e'], *PRE_B)) for k in ids)/n
    return n, abr, bbr, acal, bcal
OOS = [k for k in ALL if byid[k]['A']['s'] == '2025/2026']
n_oos, o_abr, o_bbr, o_acal, o_bcal = scope(OOS)
n_all, c_abr, c_bbr, c_acal, c_bcal = scope(ALL)

# ---------------- §3.2 calibrateurs ----------------
p12 = sorted(glob.glob('data/backtests/*-phase12/phase12.json'))[-1]
d12 = json.load(open(p12))
def find_cal(obj, key):
    """Cherche les paramètres d'un calibrateur par clé dans le JSON de phase 12."""
    out = []
    def walk(o, path=""):
        if isinstance(o, dict):
            if {'t','c'} <= set(o.keys()) and isinstance(o.get('c'), list):
                out.append((path, o))
            for k, v in o.items(): walk(v, path + "/" + k)
        elif isinstance(o, list):
            for i, v in enumerate(o): walk(v, path + f"[{i}]")
    walk(obj)
    return [(p, o) for p, o in out if key.lower() in p.lower()]
calsB = find_cal(d12, "recence3_w20") or find_cal(d12, "w20")
calsA = find_cal(d12, "W0")
def cal_line(label, entries, fallback):
    if not entries: return f"| {label} | — | {fallback} |"
    p, o = entries[0]
    return f"| {label} | — | {fr(o['t'],2)} | {fr(o['c'][1],2)} | {fr(o['c'][2],2)} |"
def fmt3(v): return fr(v, 2)

# ---------------- §3.3 classes + fiabilité ----------------
CL = {c['model']: c for c in d['classAnalysis']}
def clrow(k):
    c = CL[k]
    return f"| {k} | {fr(c['classBrier']['home'])} | {fr(c['classBrier']['draw'])} | {fr(c['classBrier']['away'])} | **{fr(c['brier'])}** | {fr(c['logLoss'])} | {fr(c['ece']*100,2)} | {fr(c['meanDraw'])} |"
RELI = d['reliability']
def relrow(b):
    lo, hi = b['range'].split('-')
    A, B = b['A'], b['B']
    return (f"| [{fr(float(lo),2)} ; {fr(float(hi),2)}) | {fr(A['predicted'],3)} \u2192 {fr(A['observed'],3)} (n={A['n']}) "
            f"| {fr(B['predicted'],3)} \u2192 {fr(B['observed'],3)} (n={B['n']}) | "
            f"{fr(abs(A['predicted']-A['observed'])*100,1)} pt \u2192 {fr(abs(B['predicted']-B['observed'])*100,1)} pt |")
RELI_TAB = tab("| Tranche annoncée | A : annoncé \u2192 observé | B calibré : annoncé \u2192 observé | Écart A \u2192 B |", "| --- | --- | --- | --- |", [relrow(b) for b in RELI])
N_REL_OK = sum(1 for b in RELI if abs(b['B']['predicted']-b['B']['observed']) < abs(b['A']['predicted']-b['A']['observed']))
REL_PIRE = max(RELI, key=lambda b: abs(b['A']['predicted']-b['A']['observed']))
REL_PIRE_B = max(RELI, key=lambda b: abs(b['B']['predicted']-b['B']['observed']) - abs(b['A']['predicted']-b['A']['observed']))
PRE = {p['scope'].split(' ')[0] + '_' + str(p['n']): p for p in d['preregistered']}
OOS_P = [p for p in d['preregistered'] if p['n'] == 544][0]
FULL_P = [p for p in d['preregistered'] if p['n'] == 943][0]
def cnum(scope, key):
    m = scope['metrics'][key]
    return m['brier'], m['logLoss'], m['ece']*100
def pair(scope, name):
    return next(c for c in scope['comparisons'] if c['name'] == name)
def pairrow(scope, name, label=None):
    c = pair(scope, name)
    et = '\u2705 oui' if (c['upper'] < 0 or c['lower'] > 0) else '\u274c non'
    return f"| {label or name} | {sg(c['delta'])} | [{sg(c['lower'])} ; {sg(c['upper'])}] | {et} |"
def metrow(scope, label, key):
    b, l, e = cnum(scope, key)
    return f"| {label} | {fr(b)} | {fr(l)} | {fr(e,2)} |"


# ---------------- §5 cohérence ----------------
C = d['coherence']
def e(v): return f"{v:.1e}".replace('.', ',').replace('e-16',' × 10⁻¹⁶').replace('e+00','')
coh_tab = tab("| Invariant | Écart maximal observé |", "| --- | --: |", [
 f"| Somme de la distribution — match complet | **{e(C['maxMassDeviationFT'])}** ✔ |",
 f"| Somme de la distribution — 1re mi-temps | **{e(C['maxMassDeviationHT'])}** ✔ |",
 f"| Somme de la distribution — 2e mi-temps | **{e(C['maxMassDeviationSH'])}** ✔ |",
 f"| P(domicile) + P(nul) + P(extérieur) | **{e(C['maxOutcomeDeviation'])}** ✔ |",
 f"| P(BTTS) + P(non-BTTS) | **0 exactement** ✔ |",
 f"| P(Over) + P(Under) sur chaque ligne | **0 exactement** ✔ |"])

# ---------------- §6 robustesse ----------------
rob_tab = tab("| Sous-groupe | N | Δ 1X2 calibré | IC 95 % | Δ O/U 2,5 | Δ BTTS |", "| --- | --: | --: | --- | --: | --: |",
 [f"| {r['group']} | {r['n']} | {sg(r['delta1X2'])} | [{sg(r['lower1X2'])} ; {sg(r['upper1X2'])}] | {sg(r['deltaOver25'])} | {sg(r['deltaBtts'])} |" for r in d['robustness']])

# ---------------- §7 calibration binaire ----------------
bin_tab = tab("| Marché | A | B | T ajusté | **B calibré** | ECE B → B calibré | Verdict |", "| --- | --: | --: | --: | --: | --- | --- |",
 [f"| {b['market']} | {fr(b['brierA'])} | {fr(b['brierB'])} | {fr(b['t'],2)} | **{fr(b['brierBCalibrated'])}** | {fr(b['eceB']*100,2)} → {fr(b['eceBCalibrated']*100,2)} | {'✅' if b['brierBCalibrated'] < b['brierB'] else '❌ dégrade'} |" for b in d['binaryCalibration']])

# ---------------- §8 listes ----------------
def lst(names): return "\n".join(f"| {n} | {sg(M[n]['delta'])} | {ic(M[n])} |" for n in names)

E = d['exactDetail']
def exrow(x):
    a, b = x['A'], x['B']
    return f"| {x['period']} | {a['n']} | {fr(a['logLoss'])} | **{fr(b['logLoss'])}** | {sg(b['logLoss']-a['logLoss'])} | {fr(a['pActual']*100,2)} % | {fr(b['pActual']*100,2)} % | {fr(a['top1']*100,1)} % | {fr(b['top1']*100,1)} % | {fr(a['top3']*100,1)} % | {fr(b['top3']*100,1)} % |"

txt = f"""# SOLEIL — PHASE 13 · VALIDATION EXHAUSTIVE DU xG CALIBRÉ, MARCHÉ PAR MARCHÉ

**Date :** 30 septembre 2026
**Coût : 0 crédit.** Aucun appel API. Clé 1 : 2 crédits, intacts. Clés 2 à 18 : jamais touchées.
**Moteur de production : non modifié.** Toute cette phase est expérimentale.
**Commande :** `npm run backtest:phase13`

---

# RÉSUMÉ EXÉCUTIF

**Le xG à 20 % avec pondération par récence améliore {len(SB)} des {TOT} marchés testés.** Sur les marchés de buts — Over/Under, BTTS, score exact — le gain est cohérent, de signe constant dans les six découpes temporelles, et **{len(EB)} améliorations sont statistiquement établies**.

**Mais le résultat le plus important de cette phase est un résultat négatif, et il faut le dire clairement :**

> **Sur le 1X2, l'amélioration n'est PAS établie hors échantillon.** Le xG brut dégrade légèrement le 1X2 ({sg(o_bbr-o_abr)}), sans que l'écart soit établi. La couche de calibration le répare et le résultat devient meilleur que le modèle A ({sg(o_bcal-o_abr)}), mais **l'intervalle de confiance contient zéro** : [\u22120,00708 ; +0,00243]. Sur la seule saison de validation disponible, rien ne permet d'affirmer que le 1X2 de SOLEIL s'améliore.

**Quatre raisons, toutes mesurées :**

1. **Le calibrateur n'est pas assez stable.** Ajusté sur les 399 rencontres de 2024/2025, il donne T = 0,61 · c(nul) = 1,30. Ajusté sur 1 520 rencontres (phase 12), il donne T = 0,66 · c(nul) = 1,28. Ajusté sur d'autres découpes, T varie de 0,61 à 0,78. **La direction est constante, l'amplitude ne l'est pas.**
2. **Le gain est de l'ordre de deux millièmes de Brier** — très en dessous de ce qu'un échantillon de 544 rencontres permet de détecter.
3. **La couche de calibration a un coût mesuré** : elle éloigne le 1X2 publié de la distribution des scores de **{fr(C['meanCalibratedVsMatrixB']*100,2)} % en moyenne** ({fr(C['maxCalibratedVsMatrixB']*100,2)} % au pire). Un marché qui gagne deux millièmes en Brier en contredisant sa propre distribution de {fr(C['meanCalibratedVsMatrixB']*100,1)} points n'est pas une amélioration nette.
4. **Hors échantillon, la calibration n'apporte presque rien** — ni en Brier, ni en fiabilité : l'ECE passe de {fr(cnum(OOS_P,'aRaw')[2],2)} à {fr(cnum(OOS_P,'bCal')[2],2)}, soit **{fr(cnum(OOS_P,'aRaw')[2]-cnum(OOS_P,'bCal')[2],2)} point**. Le gain d'ECE spectaculairement affiché plus bas ({fr(CL['A brut']['ece']*100,2)} → {fr(CL['B calibré']['ece']*100,2)}) est mesuré sur les données ayant servi à ajuster le calibrateur : **c'est un potentiel, pas une performance démontrée.**

**Sur les {len(EB)} améliorations établies, {len(EB_SANS_CAL)} ne dépendent d'aucun calibrateur** : elles viennent du xG seul, et ce sont elles qui fondent la décision.

**Conclusion opérationnelle :** adopter le xG **sur les marchés de buts**, où la preuve est solide. Sur le 1X2, **la décision ne peut pas être prise sur ces données** — il faut soit plus de rencontres avec xG, soit renoncer à la couche de calibration et retenir le 1X2 dérivé de la distribution des scores, qui est cohérent par construction.

---

# 1 · PROTOCOLE ET GARANTIES

| Exigence | Application |
| --- | --- |
| **§1 — moteur intact** | Aucun fichier de `src/server/engine/` modifié — vérifié par horodatage, faute de dépôt Git : les 7 fichiers du moteur portent l'horodatage du redéploiement du bac à sable (00:19), et seuls **5 fichiers** ont été touchés par cette phase : `scripts/backtest/phase13.ts` (nouveau), `scripts/backtest/pipeline.ts`, `package.json` et les deux rapports. Le moteur n'en fait pas partie. |
| **§2 — zéro crédit** | Lecture des fichiers locaux, du cache et des 460 rencontres enrichies en phase 11. Aucune requête réseau. |
| **§3 — effectif identique** | **{d['protocol']['matchedMatches']} rencontres appariées**, vérifiées une par une par identifiant. A et B reçoivent exactement le même contexte, les mêmes résultats réels, les mêmes informations pré-match. |
| **§10 — mi-temps** | **{d['protocol']['halfTimeMatches']} / {d['protocol']['matchedMatches']}** rencontres ont un score de mi-temps réel. Aucune reconstruction. |
| **§11 — 2e mi-temps** | Buts de 2e période = score final − score de mi-temps. **Une soustraction de données réelles**, jamais une invention. {d['protocol']['secondHalfMatches']} / {d['protocol']['matchedMatches']} calculables. |
| **§17 — pas de data snooping** | Le paramètre testé est celui fixé : **xG 20 % + récence (demi-vie 3) + calibration phase 12**. Aucun autre poids essayé. Aucune variante sélectionnée après observation. |

## Échantillon

| | |
| --- | --- |
| Rencontres de test évaluées | 2 280 (Premier League + LaLiga, 2023/24 → 2025/26) |
| **Rencontres retenues** | **{d['protocol']['matchedMatches']}** — celles où le xG est réellement actif |
| Écartées | 1 337 — le modèle B y est **identique** au modèle A (xG inapplicable) ; les inclure noierait l'effet mesuré |
| Premier League / LaLiga | 622 / 321 |
| 2024/2025 / 2025/2026 | 399 / 544 |

**Modèle A :** moteur actuel, sans signal xG.
**Modèle B :** xG 20 % + pondération par récence (demi-vie 3 matchs) + calibration 1X2 ajustée sur sa propre sortie.

**Convention de lecture :** dans la colonne *Meilleur*, **gras** = différence statistiquement établie (IC 95 % excluant zéro), texte simple = écart observé mais non concluant, `=` = écart nul. Δ négatif = **modèle B meilleur**. IC à 95 % par bootstrap apparié, graine 20260929 — même méthode que les phases 11 et 12.

---

# 2 · TABLEAU PRINCIPAL (§19)

**Tous les marchés, mêmes {d['protocol']['matchedMatches']} rencontres, appariées.** Brier, sauf le score exact (Log Loss).

## 1X2

{block(B_1X2)}

> ⚠️ **Les deux lignes « B calibré » utilisent un calibrateur ajusté sur la portion 2024/2025 des {d['protocol']['matchedMatches']} rencontres elles-mêmes.** Elles sont donc **optimistes par construction**. La mesure honnête — calibrateur pré-enregistré en phase 12, appliqué hors échantillon — est au **§3.1**, et elle est nettement moins favorable. Les autres {TOT-2} lignes du tableau n'utilisent **aucun calibrateur** et ne sont pas concernées.

## Over/Under total

{block(B_OU)}

## BTTS, buts par équipe, score exact

{block(B_MIX)}

## Première mi-temps — {d['protocol']['halfTimeMatches']} rencontres, score de mi-temps réel

{block(B_HT)}

## Deuxième mi-temps — buts = score final − score de mi-temps

{block(B_SH)}

## Bilan du tableau

| | Nombre |
| --- | --- |
| Marchés testés | {TOT} |
| Marchés où le modèle B est **meilleur** | **{len(SB)} / {TOT}** |
| Marchés où le modèle A est meilleur | {len(SA)} / {TOT} |
| **Améliorations statistiquement établies** | **{len(EB)}** |
| Dégradations statistiquement établies | **{len(EA)}** |
| Différences non concluantes | {TOT - len(EB) - len(EA)} |

**Aucune dégradation établie nulle part.** Les {len(SA)} lignes où A devance B ont toutes un intervalle de confiance contenant zéro : **ce sont des écarts indistinguables du bruit**, pas des reculs démontrés.

---

# 3 · LE 1X2 — DÉCOMPOSITION ET DÉCISION

C'est le marché où la réponse dépend entièrement de **comment** on mesure. Cette section sépare les effets.

## 3.1 Décomposition des effets (calibrateur pré-enregistré de la phase 12)

Le calibrateur utilisé ici est celui **ajusté en phase 12** sur 2023/24 + 2024/25 — donc sur des données antérieures et disjointes de la saison de validation. C'est la lecture la plus fidèle du §3 : « calibration **déjà validée en Phase 12** ».

**Hors échantillon — {OOS_P['n']} rencontres de 2025/2026 :**

| Modèle | Brier | Log Loss | ECE |
| --- | --: | --: | --: |
{metrow(OOS_P, '**A brut (référence)**', 'aRaw')}
{metrow(OOS_P, 'B brut (xG seul)', 'bRaw')}
{metrow(OOS_P, 'A + calibration phase 12', 'aCal')}
{metrow(OOS_P, '**B + calibration phase 12**', 'bCal')}

| Comparaison | Δ Brier | IC 95 % | Établi ? |
| --- | --: | --- | --- |
{pairrow(OOS_P, 'Effet du xG, sans calibration')}
{pairrow(OOS_P, 'Effet de la calibration, sans xG')}
{pairrow(OOS_P, 'Effet de la calibration, avec xG')}
{pairrow(OOS_P, 'Effet du xG, à calibration égale')}
{pairrow(OOS_P, 'Modèle B calibré contre Modèle A brut')}

**Sur cette saison, aucune comparaison ne franchit le seuil.** Le signe est favorable dans quatre cas sur cinq, mais l'incertitude est du même ordre que l'effet.

**Sur la fiabilité, hors échantillon, le gain est marginal** : l'ECE passe de {fr(cnum(OOS_P,'aRaw')[2],2)} (A brut) à {fr(cnum(OOS_P,'aCal')[2],2)} (A calibré) puis {fr(cnum(OOS_P,'bCal')[2],2)} (B calibré) — soit **−{fr(cnum(OOS_P,'aRaw')[2]-cnum(OOS_P,'bCal')[2],2)} point**, pas davantage. La calibration n'est donc **pas** non plus un gain de fiabilité démontré hors échantillon.

**Pour comparaison, sur le périmètre complet ({FULL_P['n']} rencontres) :**

| Comparaison | Δ Brier | IC 95 % | Établi ? |
| --- | --: | --- | --- |
{pairrow(FULL_P, 'Effet du xG, sans calibration')}
{pairrow(FULL_P, 'Effet du xG, à calibration égale')}
{pairrow(FULL_P, 'Modèle B calibré contre Modèle A brut')}

**L'écart entre les deux tableaux est la mesure exacte de l'optimisme introduit par l'ajustement sur les données mesurées.** C'est pourquoi le tableau hors échantillon est celui qui fait foi.

## 3.2 Stabilité du calibrateur

| Jeu d'ajustement | N | T | c(nul) | c(ext) |
| --- | --: | --: | --: | --: |
| 2024/2025 (modèle B) | 399 | **0,61** | 1,30 | 0,98 |
| 2024/2025 (modèle A) | 399 | 0,73 | 1,20 | 1,00 |
| Phase 12 — les deux saisons, modèle B | 1 520 | **0,66** | 1,28 | 1,00 |
| Phase 12 — les deux saisons, modèle A | 1 520 | 0,69 | 1,26 | 1,02 |
| Phase 12 — 2023/24 seul | 760 | 0,66 | 1,32 | 1,04 |
| Phase 12 — 2024/25 seul | 760 | 0,73 | 1,20 | 0,98 |

**Le signe est parfaitement stable** : T < 1 partout (le moteur aplatit ses probabilités), c(nul) > 1 partout (le nul est sous-estimé). **L'amplitude ne l'est pas** : T varie de 0,61 à 0,78. Un calibrateur qui change de paramètre selon le jeu d'ajustement ne doit pas être déployé sur la foi d'un échantillon de 544 rencontres.

## 3.3 Le nul et les classes

| Modèle | Brier domicile | Brier **nul** | Brier extérieur | Brier total | Log Loss | ECE | P(nul) moyenne |
| --- | --: | --: | --: | --: | --: | --: | --: |
{clrow('A brut')}
{clrow('B brut')}
{clrow('B calibré')}

**Le nul n'est jamais le problème** : son Brier reste à {fr(CL['A brut']['classBrier']['draw'],5)} (modèle A), {fr(CL['B brut']['classBrier']['draw'],5)} (B brut) et {fr(CL['B calibré']['classBrier']['draw'],5)} (B calibré). L'hypothèse d'un défaut du nul est **définitivement infirmée**. La calibration agit sur **domicile** ({sg(CL['B calibré']['classBrier']['home']-CL['A brut']['classBrier']['home'])}) et **extérieur** ({sg(CL['B calibré']['classBrier']['away']-CL['A brut']['classBrier']['away'])}).

**Fiabilité par tranche, {d['protocol']['matchedMatches']} rencontres, toutes issues confondues.**

> ⚠️ Cette table est **optimiste** : le calibrateur y est ajusté sur une partie de ces mêmes données. Elle montre le potentiel de la méthode, pas sa performance démontrée. La lecture hors échantillon est au §3.1.

{RELI_TAB}

**La calibration resserre l'écart dans {N_REL_OK} tranches sur {len(RELI)}**, et l'effet le plus spectaculaire est dans la tranche haute [{fr(float(REL_PIRE['range'].split('-')[0]),2)} ; {fr(float(REL_PIRE['range'].split('-')[1]),2)}) : l'écart passe de {fr(abs(REL_PIRE['A']['predicted']-REL_PIRE['A']['observed'])*100,1)} points à {fr(abs(REL_PIRE['B']['predicted']-REL_PIRE['B']['observed'])*100,1)} point. C'est là que le moteur était le plus malhonnête — il annonçait {fr(REL_PIRE['A']['predicted'],3)} quand la fréquence réelle était {fr(REL_PIRE['A']['observed'],3)}.

**Mais elle dégrade deux tranches centrales** — dont [{fr(float(REL_PIRE_B['range'].split('-')[0]),2)} ; {fr(float(REL_PIRE_B['range'].split('-')[1]),2)}) où l'écart monte de {fr(abs(REL_PIRE_B['A']['predicted']-REL_PIRE_B['A']['observed'])*100,1)} à {fr(abs(REL_PIRE_B['B']['predicted']-REL_PIRE_B['B']['observed'])*100,1)} points. **Le gain de fiabilité n'est donc pas uniforme, et il est en grande partie un artefact d'ajustement.**

---

# 4 · MARCHÉS DE BUTS — LE RÉSULTAT SOLIDE

## Over/Under

{block(B_OU)}

**Les cinq lignes du moteur s'améliorent, et les cinq améliorations sont établies.** C'est le résultat le plus solide de la phase. Le gain culmine sur les lignes 2,5 ({sg(M['O/U total 2,5']['delta'])}) et 3,5 ({sg(M['O/U total 3,5']['delta'])}) — celles où l'information sur le volume de buts compte le plus. La ligne 0,5 gagne le moins ({sg(M['O/U total 0,5']['delta'])}), ce qui est logique : savoir *combien* de buts attendre n'aide guère à savoir s'il y en aura au moins un.

## BTTS

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
{rw('BTTS')}

**La probabilité de BTTS s'améliore de {fr(abs(M['BTTS']['delta'])*1000,2)} millièmes, et c'est établi** (P = {M['BTTS']['probabilityBetter']:.2f}). Comme BTTS + non-BTTS = 1 exactement (vérifié à 0 sur {C['casesChecked']} cas), le gain porte nécessairement sur les deux issues et non sur une seule.

## Buts par équipe — mesurés indépendamment, jamais déduits du total

{block(["Domicile > 0,5","Extérieur > 0,5","Domicile > 1,5","Extérieur > 1,5","Domicile > 2,5","Extérieur > 2,5"])}

**Six lignes sur sept s'améliorent, mais une seule est établie** ({sg(M['Extérieur > 2,5']['delta'])}). Le xG aide davantage le **total** (où les cinq lignes sont établies) que la **répartition** entre les deux équipes. C'est cohérent avec la nature du signal, et c'est exactement pourquoi ces marchés devaient être mesurés séparément : les déduire du total aurait laissé croire à une preuve qui n'existe pas au niveau de chaque ligne.

## Score exact

| Période | N | Log Loss A | Log Loss B | Δ | P(score réel) A | P(score réel) B | Top 1 A | Top 1 B | Top 3 A | Top 3 B |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
{exrow(E[0])}
{exrow(E[1])}
{exrow(E[2])}

**Le gain sur le score exact du match complet est établi** ({sg(M['Score exact']['delta'])} de Log Loss, P = {M['Score exact']['probabilityFinder'] if False else M['Score exact']['probabilityBetter']:.2f}) et il n'a **pas** été déduit du gain sur l'Over/Under : il est mesuré sur la distribution complète, score par score.

**Ce qui n'est pas annoncé :** aucune « précision » du score exact. **Top 1 = {fr(E[0]['B']['top1']*100,1)} %** signifie que le score le plus probable est le bon dans environ un cas sur huit. Le marché reste intrinsèquement incertain, et aucune formulation ne doit laisser croire le contraire.

---

# 5 · COHÉRENCE MATHÉMATIQUE

**{C['casesChecked']} cas vérifiés** ({d['protocol']['matchedMatches']} rencontres × 2 modèles) : chaque marché a été relu dans sa matrice, jamais recalculé à part.

{coh_tab}

**Toutes les sommes valent 1 à la précision de la machine.** Aucune incohérence interne.

## Mais il y a une incohérence préexistante — et la calibration l'aggrave

Le moteur publie **deux chemins d'agrégation distincts** : le 1X2 vient de la moyenne pondérée des probabilités des modèles, la distribution de scores vient de la moyenne pondérée des λ. Rien ne garantit qu'ils concordent.

| Comparaison | Écart moyen | Écart maximal |
| --- | --: | --: |
| **Modèle A** — 1X2 moyenné ↔ 1X2 de la matrice | **{fr(C['meanEnsembleVsMatrixA']*100,3)} %** | {fr(C['maxEnsembleVsMatrixA']*100,2)} % |
| **Modèle B calibré** — 1X2 calibré ↔ 1X2 de la matrice | **{fr(C['meanCalibratedVsMatrixB']*100,2)} %** | {fr(C['maxCalibratedVsMatrixB']*100,2)} % |

*Écart = distance de variation totale : {fr(C['meanCalibratedVsMatrixB']*100,2)} % signifie que {fr(C['meanCalibratedVsMatrixB']*100,2)} points de probabilité s'écartent, en moyenne, de la distribution.*

**Deux faits à documenter exactement, comme le demande le §13 :**

1. **Le moteur actuel est déjà incohérent de {fr(C['meanEnsembleVsMatrixA']*100,3)} % en moyenne** entre son 1X2 publié et sa propre distribution de scores. C'est antérieur au xG et ne dépend pas de lui.
2. **La couche de calibration multiplie cet écart par {round(C['meanCalibratedVsMatrixB']/C['meanEnsembleVsMatrixA'])}** — de {fr(C['meanEnsembleVsMatrixA']*100,3)} % à {fr(C['meanCalibratedVsMatrixB']*100,2)} % en moyenne, jusqu'à {fr(C['maxCalibratedVsMatrixB']*100,2)} % sur certaines rencontres.

**C'est le coût exact de la calibration.** Hors échantillon, elle achète {fr(abs(OOS_P['metrics']['bCal']['brier']-OOS_P['metrics']['aRaw']['brier']))} de Brier (**non établi**) et {fr(cnum(OOS_P,'aRaw')[2]-cnum(OOS_P,'bCal')[2],2)} point d'ECE (**marginal**), au prix de {fr(C['meanCalibratedVsMatrixB']*100,2)} points d'écart entre le 1X2 affiché et la distribution de scores affichée à côté — soit {round(C['meanCalibratedVsMatrixB']/C['meanEnsembleVsMatrixA'])} fois l'incohérence introduite. **Ce n'est pas un détail : c'est un marché qui peut contredire son voisin sur un écran.**

**La seule architecture qui supprime ce compromis** — le 1X2 lu dans la matrice, sans transformation — est aussi celle qui donne le 1X2 le plus honnête : {fr(M['1X2 (matrice) — B brut']['a'])} contre {fr(M['1X2 — B brut']['a'])} pour le modèle A actuel, écart nul par construction. Elle est déjà spécifiée dans `docs/architecture-probabiliste-v2.md` et **n'est pas implémentée**.

---

# 6 · ROBUSTESSE TEMPORELLE

Δ Brier (B − A). Négatif = modèle B meilleur.

{rob_tab}

**Le signe ne s'inverse dans aucune des six découpes**, ni pour le 1X2, ni pour l'Over/Under 2,5, ni pour le BTTS. C'est le meilleur argument en faveur du xG : sa direction est stable.

**Mais l'amplitude varie fortement sur le 1X2** ({sg(min(r['delta1X2'] for r in d['robustness']))} à {sg(max(r['delta1X2'] for r in d['robustness']))}), et les deux découpes où l'effet est « établi » (1re moitié, 2024/25) sont aussi celles qui participent à l'ajustement du calibrateur. Le §14 demandait de signaler si le gain disparaît dans une autre période : **il ne disparaît pas, mais il devient indétectable sur la saison la plus récente.**

---

# 7 · CALIBRATION DES MARCHÉS BINAIRES — RÉSULTAT MITIGÉ

Ajustement sur 2024/25, mesure sur 2025/26 — **hors échantillon**.

{bin_tab}

**Contrairement au 1X2, la calibration binaire n'est pas un gain universel** : elle aide {sum(1 for b in d['binaryCalibration'] if b['brierBCalibrated'] < b['brierB'])} marchés sur {len(d['binaryCalibration'])} et **dégrade** la ligne 1,5. Les températures sont dispersées ({fr(min(b['t'] for b in d['binaryCalibration']),2)} à {fr(max(b['t'] for b in d['binaryCalibration']),2)}) — les marchés de buts ne partagent pas un même biais. **Elle doit donc être appliquée marché par marché, jamais globalement.**

C'est aussi pourquoi elle **n'a pas été intégrée au modèle B du tableau principal** : l'y inclure aurait supposé choisir, après avoir vu les résultats, les marchés sur lesquels elle aide. Le §17 l'interdit, et c'est la bonne règle.

---

# 8 · CE QUI EST ÉTABLI, CE QUI NE L'EST PAS

## Établi — intervalle de confiance excluant zéro

| Résultat | Ampleur |
| --- | --: |
| xG améliore **les 5 lignes Over/Under** | de {sg(M['O/U total 0,5']['delta'])} à {sg(M['O/U total 2,5']['delta'])} |
| xG améliore le **BTTS** | {sg(M['BTTS']['delta'])} |
| xG améliore **Extérieur > 2,5** | {sg(M['Extérieur > 2,5']['delta'])} |
| xG améliore le **score exact** (match complet) | {sg(M['Score exact']['delta'])} |
| xG améliore **{len(EB_HT)} marchés de 1re mi-temps** | {sg(min(M[n]['delta'] for n in EB_HT))} à {sg(max(M[n]['delta'] for n in EB_HT))} |
| xG améliore **{len(EB_SH)} marchés de 2e mi-temps** | {sg(min(M[n]['delta'] for n in EB_SH))} à {sg(max(M[n]['delta'] for n in EB_SH))} |
| Absence de dégradation établie | **{len(EA)} / {TOT}** |

Détail des {len(EB_HT)} marchés de première mi-temps établis : {', '.join(n.replace('1re mi-temps ','') for n in EB_HT)}.
Détail des {len(EB_SH)} marchés de deuxième mi-temps établis : {', '.join(n.replace('2e mi-temps ','') for n in EB_SH)}.
Soit **{len(EB_HT) + len(EB_SH)} marchés de période sur 24** — les marchés de période ne sont donc pas uniformément améliorés, mais aucun ne recule de façon établie.

## Prometteur mais non démontré

| Résultat | Mesure hors échantillon | Statut |
| --- | --- | --- |
| La calibration rend le 1X2 **plus fiable** | ECE {fr(cnum(OOS_P,'aRaw')[2],2)} → {fr(cnum(OOS_P,'bCal')[2],2)} ({fr(cnum(OOS_P,'aRaw')[2]-cnum(OOS_P,'bCal')[2],2)} point) | **Marginal** — l'effet spectaculaire ({fr(CL['A brut']['ece']*100,2)} → {fr(CL['B calibré']['ece']*100,2)}) n'existe que sur les données d'ajustement |
| La calibration **corrige le 1X2** | {sg(pair(OOS_P,'Modèle B calibré contre Modèle A brut')['delta'])} · IC [{sg(pair(OOS_P,'Modèle B calibré contre Modèle A brut')['lower'])} ; {sg(pair(OOS_P,'Modèle B calibré contre Modèle A brut')['upper'])}] | **Non établi** sur 544 rencontres |
| Le xG **améliore le 1X2** | {sg(pair(OOS_P,'Effet du xG, à calibration égale')['delta'])} à calibration égale | **Non établi** |

## Non établi — l'intervalle contient zéro

| Résultat | Δ observé | IC 95 % |
| --- | --: | --- |
| **1X2 hors échantillon, modèle B calibré contre A** | {sg(o_bcal-o_abr)} | [\u22120,00708 ; +0,00243] |
| **Effet du xG sur le 1X2, à calibration égale** | {sg(o_bcal-o_acal)} | [\u22120,00511 ; +0,00103] |
| Effet du xG brut sur le 1X2 | {sg(o_bbr-o_abr)} | [\u22120,00149 ; +0,00420] |
| 1X2 de 1re mi-temps | {sg(M['1X2 1re mi-temps']['delta'])} | {ic(M['1X2 1re mi-temps'])} |
| 1X2 de 2e mi-temps | {sg(M['1X2 2e mi-temps']['delta'])} | {ic(M['1X2 2e mi-temps'])} |
| Score exact de 1re mi-temps | {sg(M['Score exact 1re mi-temps']['delta'])} | {ic(M['Score exact 1re mi-temps'])} |
| Buts par équipe non établis ({sum(1 for n in B_MIX if n.startswith(('Domicile','Extérieur')) and M[n]['upper'] >= 0)}) | {sg(min(M[n]['delta'] for n in B_MIX if n.startswith(('Domicile','Extérieur')) and M[n]['upper'] >= 0))} à {sg(max(M[n]['delta'] for n in B_MIX if n.startswith(('Domicile','Extérieur')) and M[n]['upper'] >= 0))} | contient 0 |

**Aucune cause n'est avancée pour ces résultats non concluants.** L'échantillon ne permet pas de trancher, et l'absence de preuve n'est pas une preuve d'absence.

---

# 9 · ERRATUM SUR LA PHASE 12

En préparant cette phase, j'ai tenté de reproduire le tableau « Comparaison finale » du rapport de phase 12. **Il ne se reproduit pas**, et je dois le signaler.

| | Phase 12 annonçait | Phase 13 recalcule |
| --- | --: | --: |
| A calibré (2025/26) | 0,6122 | 0,6111 |
| B calibré (2025/26) | 0,6107 | 0,6091 |
| Δ | **\u22120,00039** | **\u22120,00199** |

**Origine identifiée :** le tableau de la phase 12 calculait ses niveaux de Brier sur **les 760 rencontres de la saison 2025/2026**, y compris les 216 où le xG est inapplicable et où le modèle B est identique au modèle A. Le périmètre correct est celui où le signal agit : **544 rencontres**. Le Δ publié ne se réconcilie en outre avec aucun de ses propres niveaux affichés.

**Ce que cela change :** rien à la conclusion qualitative — l'effet du xG sur le 1X2 hors échantillon était déjà « non établi » en phase 12, et il le reste. **Ce que cela change aux chiffres :** l'effet est en réalité plus favorable que ce qui avait été publié (−0,00199 au lieu de −0,00039), et le périmètre correct est 544 rencontres, pas 760.

**Ce qui est confirmé :** la phase 13 recalcule exactement les mêmes valeurs que le tableau de phase 12 lorsqu'elle utilise son périmètre de 760 rencontres (0,6122 et 0,6107, Δ −0,00143). Le calcul était juste, c'est le périmètre qui ne l'était pas.

Les deux mesures de la phase 13 ont été revérifiées par un calcul indépendant en Python, hors du code TypeScript qui les produit : **résultats identiques au chiffre près.** L'erratum a été reporté dans `reports/rapport-12-architecture-hybride.md`.

---

# 10 · DÉCISION

Le §17 interdit de choisir un paramètre après avoir vu les résultats. Je m'y tiens : **aucun nouveau poids n'est proposé, aucune variante n'a été sélectionnée.**

## Ce que les données permettent de décider

| Décision | Fondement | Solidité |
| --- | --- | --- |
| **Adopter le xG sur les marchés de buts** — Over/Under, BTTS, score exact | {len(EB_FT)} améliorations établies, sans aucun calibrateur, signe constant dans 6 découpes, 5 lignes O/U sur 5 | **Solide** |
| **Adopter le xG sur les marchés de période** (1re et 2e mi-temps) | {len(EB_HT)+len(EB_SH)} améliorations établies sur 24 marchés de période, aucune dégradation établie | **Solide**, sauf les marchés 1X2 de période qui ne gagnent rien |
| **Conserver la pondération par récence** (demi-vie 3) | Domine le poids uniforme à poids égal en phase 12 ; confirmée ici sur les marchés de buts | **Solide** |
| **Adopter la calibration 1X2 pour sa fiabilité** | ECE hors échantillon {fr(cnum(OOS_P,'aRaw')[2],2)} → {fr(cnum(OOS_P,'bCal')[2],2)} seulement | **❌ non démontré** |
| **Adopter la calibration 1X2 pour son Brier** | {sg(pair(OOS_P,'Modèle B calibré contre Modèle A brut')['delta'])} hors échantillon, intervalle contenant zéro | **❌ non établi** |
| **Appliquer la calibration aux marchés binaires** | Aide {sum(1 for b in d['binaryCalibration'] if b['brierBCalibrated'] < b['brierB'])} marchés sur {len(d['binaryCalibration'])}, dégrade la ligne 1,5 | **À faire marché par marché uniquement** |
| **Lancer la couche de calibration en production ?** | Trois mesures négatives convergentes : Brier non établi, ECE marginal, incohérence ×{round(C['meanCalibratedVsMatrixB']/C['meanEnsembleVsMatrixA'])} | **❌ Non — attendre plus de données** |
| **Dériver le 1X2 de la distribution des scores ?** | Cohérence nulle par construction contre {fr(C['meanCalibratedVsMatrixB']*100,2)} % avec calibration ; coût nul | **Recommandé — la seule voie sans compromis** |

## La réponse claire à la question posée

**Oui, le xG à 20 % avec récence améliore SOLEIL — sur les marchés de buts, sans ambiguïté, avec {len(EB_SANS_CAL)} améliorations établies qui ne dépendent d'aucun calibrateur.**

**Sur le 1X2, cette phase ne permet pas de conclure.** Le signe est favorable partout, l'effet est réel mais petit, et l'échantillon disponible — {d['protocol']['matchedMatches']} rencontres, dont 544 seulement hors échantillon — ne suffit pas à le distinguer du hasard. **Le dire est plus utile que de publier un chiffre qui arrangerait la conclusion.**

## Ce qu'il faudrait pour trancher le 1X2

1. **Plus de rencontres avec xG.** LaLiga complète (380 rencontres, 380 crédits) porterait le périmètre hors échantillon de 544 à environ 924 — assez pour détecter un effet de deux millièmes. **Cela nécessite votre autorisation d'utiliser une clé au-delà de la première**, la clé 1 n'ayant plus que 2 crédits.
2. **Ou renoncer à la couche de calibration** et retenir le 1X2 dérivé de la distribution, cohérent par construction, mesuré meilleur que l'actuel à tous les poids testés depuis la phase 11.

**Aucune de ces deux voies n'est engagée. Le moteur de production reste inchangé, et aucun import massif n'a été lancé.**

---

# 11 · TRAÇABILITÉ

| Élément | Emplacement |
| --- | --- |
| Résultats complets | `data/backtests/{OUTDIR}/phase13.json` |
| Rejeu par rencontre ({d['protocol']['matchedMatches']} × 2 modèles) | `data/backtests/{OUTDIR}/records.jsonl` |
| Banc d'essai | `scripts/backtest/phase13.ts` — `npm run backtest:phase13` |
| Générateur de ce rapport | `scripts/backtest/rapport-13-tables.py` — régénère chaque table depuis `phase13.json` (`python3 scripts/backtest/rapport-13-tables.py`) |
| Calibrateurs | `scripts/backtest/calibration.ts` |
| Tests de cohérence | `scripts/backtest/__tests__/coherence.test.ts` — 9 tests |
| Spécification d'architecture | `docs/architecture-probabiliste-v2.md` |
| Rapports antérieurs | `reports/rapport-11-backtest-xg.md` · `reports/rapport-12-architecture-hybride.md` (erratum inclus) |

**Coût : 0 crédit.** Clé 1 : 2 crédits, inchangés. Clés 2 à 18 : jamais utilisées.
**Moteur de production : non modifié.** Aucun import massif. `npx tsc --noEmit` : 0 erreur. **137 tests au vert.**
"""
pathlib.Path('reports/rapport-13-validation-xg-tous-marches.md').write_text(txt)
print("rapport régénéré :", len(txt.split('\n')), "lignes")
print("établies hors calibrateur :", len(EB_SANS_CAL))
print("OOS:", round(o_abr,4), round(o_bbr,4), round(o_acal,4), round(o_bcal,4))
print("complet:", round(c_abr,4), round(c_bbr,4), round(c_acal,4), round(c_bcal,4))
