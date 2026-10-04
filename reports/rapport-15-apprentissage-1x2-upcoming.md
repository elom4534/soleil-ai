# SOLEIL — Rapport Phase 15

**1X2 par distribution · xG calibré pour les buts · apprentissage des erreurs · matchs à venir uniquement**

Date : 30/09/2026 · Crédits consommés : **0** (clé 1 : 2 crédits intacts ; clés 2–18 : jamais utilisées)
Environnement : base locale reconstruite (`scripts/restore.sh`), 8 360 rencontres, 780 prédictions, 776 réglées.

---

## Décisions structurantes

| # | Décision | Fondement |
|---|---|---|
| 1 | Le 1X2 publié est **dérivé de la distribution de scores** (`OUTCOME_SOURCE = "matrix"`) | Exigence §1 + mesure : gain établi mais très petit ; **0 ligne dégradée** |
| 2 | Le **poids du xG reste 0,20** | §2 : 6 marchés de buts établis, 0 dégradé ; aucun nouveau poids justifié |
| 3 | **Aucune prédiction publiée n'est réécrite** | Les 780 prédictions de l'ère « consensus » restent telles quelles |
| 4 | La promotion de version est **lue dans le backtest**, jamais déclarée à la main | §7/§8, `registry.ts` + `learning-build.ts` |
| 5 | L'interface publique ne montre que des rencontres à venir avec prédiction valide | §9–§12 |
| 6 | L'agent IA explique, ne calcule jamais | §18, test §20.9 |

---

## Volet 1 — Modèle

### Architecture finale

Une seule source de vérité : **la matrice des scores** (Poisson bivarié, `rho`,
lambdas issus du consensus pondéré des modèles).

- **1X2** — `P(1) = Σ P(score)` avec buts domicile > extérieur ; `P(X)` = égalité ;
  `P(2)` = infériorité. Aucun xG « calibré » n'est appliqué par-dessus.
- **Marchés de buts** (Over/Under, BTTS, buts par équipe) — lus dans la même matrice.
- **Scores exacts** — classement lu dans la distribution complète, formulation
  « Scores exacts les plus probables », jamais « garanti ».
- **Mi-temps** — xG seulement si les données existent **et** que le marché est
  couvert ; sinon indisponibilité déclarée.

Pièces : `src/server/engine/{index,ensemble,models}.ts`, `src/lib/constants.ts`
(`OUTCOME_SOURCE`, `ENGINE_VERSION`), `src/lib/coherence.ts`.

### Marchés où le xG apporte une amélioration **mesurée**

Backtest `data/backtests/2026-09-30T11-02-58-726Z-phase15/` — xG à 0 contre xG à 0,20,
sur les 943 rencontres où le xG est réellement disponible :

| Marché | Brier sans xG | Brier avec xG | Δ | IC 95 % | ECE |
|---|---|---|---|---|---|
| Over 1,5 | 0,16492 | 0,16420 | −0,00072 | [−0,00133 ; −0,00010] | 3,82 → 2,01 |
| Over 2,5 | 0,24607 | 0,24504 | −0,00103 | [−0,00202 ; −0,00005] | 3,15 → 3,70 |
| Over 3,5 | 0,20756 | 0,20595 | −0,00162 | [−0,00263 ; −0,00062] | 3,76 → 3,76 |
| Over 4,5 | 0,12398 | 0,12299 | −0,00099 | [−0,00167 ; −0,00033] | 3,23 → 2,56 |
| BTTS oui | 0,24804 | 0,24696 | −0,00108 | [−0,00187 ; −0,00028] | 4,17 → 2,67 |
| Extérieur > 2,5 | 0,09967 | 0,09884 | −0,00083 | [−0,00150 ; −0,00018] | 5,03 → 5,24 |

**6 marchés établis, 0 dégradé.** Hors échantillon 2025/2026 (544 rencontres),
5 de ces 6 restent établis (Over 4,5 devient non établi) et Over 0,5 s'y ajoute.

**Marchés où le gain n'est pas établi** (donc aucune revendication) :
Over 0,5 · Dom > 0,5 · Dom > 1,5 · Dom > 2,5 · Ext > 0,5 · Ext > 1,5.

### Marchés laissés à la distribution seule

- **Score exact** — Log Loss 2,9076 → 2,9036 (Δ −0,0040, IC [−0,0080 ; +0,0003]) :
  **non établi**. Le xG n'est donc jamais présenté comme un gain sur le score exact.
- **1X2** — dérivé de la distribution, sans intervention du xG. Le backtest
  confirme cette prudence : ajouter le xG à la matrice ne fait pas mieux sur le
  1X2 (Δ +0,0016, IC [−0,0005 ; +0,0036], non établi).

### Poids du xG

`BASE_WEIGHTS.xg = 0,20`, plafond d'un modèle à 45 % du poids total. Le poids est
**lu à la source** par le script d'apprentissage (jamais recopié), donc une
version enregistrée ne peut pas annoncer un poids qui n'est pas celui du moteur.

---

## Volet 2 — Apprentissage

### Données et découpage temporel

- 8 360 rencontres normalisées (E0, SP1, 11 saisons), 460 enregistrements xG réels.
- Backtest : 1 520 rencontres évaluées (943 avec xG), saison 2025/2026 tenue
  **hors échantillon** pour tous les verdicts rapportés.
- Aucun tirage aléatoire : le passé entraîne, le futur valide.

### Mémoire d'erreurs (§4, §5)

`npx tsx scripts/learning-build.ts` produit une ligne par prédiction réglée :

- **776 lignes** écrites, 0 inexploitable ;
- écriture **idempotente** (2ᵉ passage : 776 déjà en base, 0 écriture) ; `--refresh`
  pour recalculer explicitement ;
- le script n'écrit **que** dans `PredictionError` et `ModelVersion` — aucune
  prédiction n'est touchée (test §20.12) ;
- empreinte des données enregistrée avec chaque version (`3f0a937113362a23`).

### Métriques mesurées (776 prédictions réglées)

Brier 1X2 **0,6106** · Log Loss **1,0197** · réussite de l'issue publiée **47,8 %** ·
erreur de calibration (ECE) **5,23 pt** · 564 prédictions concernées par le xG.

### Erreurs récurrentes — mesures, sans cause inventée

| Famille | Constat mesuré |
|---|---|
| Favoris / nuls | Domicile : réussite 52,4 % (477), biais 1X2 −4,9 pt · Extérieur : réussite 40,5 % (299), biais −5,1 pt |
| Niveau de confiance | 55–67 : 38,7 % (31) · 68–79 : 51,5 % (99) · 80+ : 47,3 % (630) |
| Qualité de données | EXCELLENT 750 (Brier 0,6106) · GOOD 26 (0,6084) |
| Avec / sans xG | sans xG 212 (Brier 0,6140) · avec xG 564 (0,6092) |
| Niveau de buts attendu | < 2,2 buts : Brier 0,6463 (51) · 3,4 et plus : 0,5374 (34) |
| Compétition | E0 : Brier 0,6312 (390) · SP1 : 0,5896 (386) |
| Saison | 2024-2025 : 60,0 % (20) · 2025-2026 : 47,5 % (756) |

Aucune de ces lignes n'affirme *pourquoi* l'écart existe. Les lectures générées
sont factuelles et les tests refusent les formulations causales
(« parce que », « à cause », « donc », « prouve »).

### Versions (§7, §8)

| Version | État | Contenu |
|---|---|---|
| `1.0.0-xg0.20` | **Archivée** | 776 mesures de l'ère « consensus » conservées ; note de provenance explicite (antérieure au suffixe de provenance) |
| `1.0.0-matrix-xg0.2` | **En production** | validation lue dans le backtest : candidat 0,61253 vs 0,61381, Δ −0,00128 [−0,00260 ; −0,00029], **établi** — promotion enregistrée par `decidePromotion()` |

Règle appliquée : pas de promotion sans gain **hors échantillon** établi ; un
retour arrière (`rollbackVersion`) reste disponible et journalisé.

### Diagnostic de bascule du 1X2

Trace complète : `data/learning/phase15-bascule-1x2.md` (motif, chiffres,
correction du banc d'essai, comparaison champ par champ, empreintes).

---

## Volet 3 — Interface

### Séparation des deux mondes (§9–§12)

| Mesure | Valeur |
|---|---|
| Rencontres **affichables** (à venir + prédiction publiée + cohérente) | **0** |
| Rencontres terminées masquées, conservées pour l'analyse | **8 360** |
| En cours / reportées / annulées masquées | 0 |
| Rencontres à venir sans prédiction (jamais affichées) | 0 |
| Rencontres à venir dont la prédiction n'a pas passé les seuils | 0 |

La base locale ne contient **aucune rencontre future** (saisons 2024/2025 et
2025/2026 jouées) : la liste publique est donc vide **par construction**, et
l'état vide est explicite (« aucune rencontre ne correspond », « SOLEIL
n'affiche jamais de prédiction sur des données insuffisantes »). Le
comportement §9–§12 est vérifié par les tests §20.1–§20.3 et §20.10–§20.11 sur
des jeux d'essai.

Page interne `/apprentissage` : mémoire d'erreurs, diagnostics, versions. Elle ne
présente **aucune** prédiction à venir, et l'indique en tête de page.

### Visuels (§13–§16)

| Entité | Total | Logo de la source | Cache local | Repli |
|---|---|---|---|---|
| Équipes | 65 | 0 | 0 | 65 monogrammes |
| Compétitions | 2 | 0 | 0 | 2 monogrammes |
| Pays | 2 | — | — | 2 drapeaux (code officiel fourni par la source) |

Les sources actives (football-data.co.uk, TheSportsDB) ne publient pas de
blason : **aucune URL n'est inventée**, le repli monogramme s'affiche, et une
image qui échoue bascule sur le repli au lieu d'un carré cassé (`Assets.tsx`).
Le cache `AssetCache` (provenance + `lastVerified`) est en place pour les
sources qui fourniront des logos.

### Cohérence avant affichage (§19)

`src/lib/coherence.ts` contrôle Σ 1X2, Σ distributions, couples Over/Under, BTTS
et scores exacts : une incohérence devient `INVALID` et n'est pas affichée. Une
prédiction produite **avant** la bascule garde ses valeurs et affiche la note
d'écart historique — information honnête, jamais correction silencieuse.

---

## Volet 4 — Qualité

| Contrôle | Résultat |
|---|---|
| Tests automatisés | **162 / 162** (11 suites), dont **12 tests §20** et 11 tests de cohérence d'affichage |
| Anti-fuite temporelle | suite `leakage.test.ts` (10 tests) — la rencontre cible ne peut pas contribuer ses propres xG/tirs/possession/corners/événements/score |
| TypeScript | `npx tsc --noEmit` → **0 erreur** |
| Lint | `npm run lint` → **0 erreur**, 19 avertissements préexistants (variables non utilisées) |
| Build de production | `npx next build` → **OK**, 12 routes (dont `/apprentissage`) |
| Affichage ↔ moteur | `ui-verify --matches 5` → **80 / 80** |
| Fidélité banc ↔ moteur | écart maximal **5,55e-17** sur 8 rencontres (après bascule) |
| Empreinte moteur | `f6526b80…` — écart à la référence expliqué et documenté (2 champs de traçabilité + bascule §1) |
| Performance (prod) | `/` 0,22 s · `/matchs` 0,09 s · `/top-picks` 0,06 s · `/apprentissage` 0,28 s · `/analyses` 0,63 s · `/profil` 0,06 s · `/admin` 0,09 s · `/performance` 4,78 s |
| Base de données | 8 360 rencontres · 780 prédictions (776 réglées, 4 générées) |

### Anti-fuite temporelle — état

Le garde-fou est structurel (le contexte d'une rencontre est construit sans
aucune donnée postérieure au coup d'envoi) et **testé à chaque exécution**.
Le backtest refuse de démarrer si le banc ne reproduit pas le moteur.

### Réserve honnête sur la performance

Aucun chiffre d'exactitude n'est présenté comme un argument : la réussite de
l'issue publiée (47,8 %) dépend du calendrier et du hasard des résultats. Le
critère de qualité retenu est la **calibration**, pas le taux de réussite.

---

## Limites, réserves et points non faits

1. **Gain du 1X2 par distribution : petit et non établi sur le dernier sous-ensemble
   avec xG.** La bascule est un choix de cohérence (§1) appuyé sur une mesure ;
   elle n'est pas vendue comme une amélioration visible.
2. **Les 780 prédictions en base sont antérieures à la bascule.** Elles portent
   la note d'écart historique. Une reconstruction complète de la base locale
   (0 crédit) supprimerait cette note, mais réécrirait l'historique : ce n'est
   pas fait, conformément à la règle d'immuabilité.
3. **Aucun logo officiel n'est disponible** avec les sources actives : la
   couverture visuelle repose sur les replis. Le cache est prêt pour des sources
   qui en fournissent.
4. **Aucune rencontre future en base** : §9–§12 est prouvé par tests, pas par
   une capture d'écran de production.
5. **`/matchs/inexistant` répond 200** (comportement de Next 16 en flux) —
   documenté depuis la Phase 14, non résolu, non retenté.
6. **Aucun test n'a été fait sur une rencontre en direct** : le moteur live reste
   hors périmètre (documentation seulement).
7. **La base locale a montré des coupures de connexion** en cours de phase
   (daemon Prisma) : deux campagnes de vérification ont dû être relancées après
   redémarrage de la base. Ce point est environnemental, pas applicatif.

---

## Condition de sortie (vérifiée point par point)

> « SOLEIL apprend de ses erreurs historiques sans utiliser d'information future,
> conserve un historique immuable des prédictions, utilise le xG là où il apporte
> une amélioration mesurée, dérive le 1X2 de sa distribution de scores, et ne
> présente à l'utilisateur que des matchs futurs disposant d'une prédiction valide. »

| Exigence | Preuve |
|---|---|
| Apprend de ses erreurs | 776 lignes d'erreur + 7 familles de diagnostics, mesures sans causalité inventée |
| Sans information future | Découpage temporel, suite anti-fuite, cible exclue de son propre contexte |
| Historique immuable | Aucune écriture sur `Prediction` par l'apprentissage ; test §20.12 ; 780 prédictions intactes |
| xG là où il améliore | 6 marchés de buts établis, 0 dégradé ; marchés non établis laissés au xG absent |
| 1X2 dérivé de la distribution | `OUTCOME_SOURCE = "matrix"` ; preuve champ par champ que seul le 1X2 bouge |
| Matchs futurs à prédiction valide uniquement | Filtre à trois étages + §19 ; 0 affichage sur 8 360 rencontres terminées |

---

## Fichiers de référence

- Backtest : `data/backtests/2026-09-30T11-02-58-726Z-phase15/resultats.json`
  (et `…11-02-13-762Z…`, `…10-42-25-002Z…` conservés)
- Diagnostics : `data/learning/2026-09-30T11-05-57-775Z/diagnostics.json`
- Trace de bascule : `data/learning/phase15-bascule-1x2.md`
- Code : `src/server/learning/{metrics,diagnostics,registry}.ts`,
  `src/server/predictions/upcoming.ts`, `src/components/match/Assets.tsx`,
  `src/app/apprentissage/page.tsx`, `scripts/learning-build.ts`
- Migration : `prisma/migrations/20260930120000_phase15_learning_assets`,
  `prisma/migrations/20260930121000_phase15_prediction_error_accuracy`
