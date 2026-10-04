# SOLEIL — Architecture probabiliste v2

**Statut : SPÉCIFICATION. NON IMPLÉMENTÉE.**

Ce document décrit l'architecture validée par les phases 11 et 12 (backtest A/B et banc
d'essai du consensus). **Aucune ligne de `src/server/engine/` n'a été modifiée.** Le présent
document existe pour qu'une décision ultérieure puisse être prise — et appliquée — sans
refaire les mesures.

| | |
| --- | --- |
| Rédigé le | 29 septembre 2026 |
| Décision d'origine | Phase 12, option « documentation seulement » |
| Mesures de référence | `reports/rapport-11-backtest-xg.md`, `reports/rapport-12-architecture-hybride.md` |
| Données d'appui | `data/backtests/2026-09-29T23-43-15-138Z-phase12/` |
| Coût de la validation | **0 crédit** (460 rencontres xG payées en phase 11 : 462 crédits) |

---

## 1. Le problème que cette architecture résout

Le moteur actuel agrège **par deux chemins distincts** :

```
1X2       ←  moyenne pondérée des probabilités 1X2 de chaque modèle
matrice   ←  moyenne pondérée des λ de chaque modèle → Poisson / Dixon-Coles
             → Over/Under, BTTS, buts par équipe, score exact, mi-temps
```

Rien ne garantit que le 1X2 publié soit celui qu'implique la distribution des scores
publiée à côté. **Deux marchés du même écran peuvent donc se contredire.**

Mesures de la phase 12, sur 943 rencontres où le signal xG est actif :

| Constat | Mesure |
| --- | --- |
| Le xG détériore le 1X2 **brut** | +0,00179 (IO 20 %), croissant jusqu'à +0,00343 (40 %), monotone |
| Le xG améliore les marchés de buts | O/U 2,5 −0,00103 · BTTS −0,00108, **significatifs à tous les poids** |
| Le 1X2 dérivé de la matrice est **meilleur** que le 1X2 moyenné | −0,00026 à −0,00051, **à tous les poids** |
| Après calibration, xG et sans-xG deviennent **indiscernables** sur le 1X2 | +0,00008 [−0,00036 ; +0,00055] |
| Le meilleur dispositif global | **récence 3 · 20 % · dérivé de la matrice · calibré** = 0,6098 (validation 2025/26) |

**Conclusion qui fonde l'architecture :** la détérioration du 1X2 n'était pas un défaut du
xG mais un **défaut de calibration du moteur, révélé par le xG**. La correction est
architecturale, pas informationnelle.

---

## 2. Architecture cible

```
                     MATCH CONTEXT
                (historique strictement antérieur)
                            │
                  ┌─────────┴─────────┐
                  ↓                   ↓
          MODÈLE DE BUTS         MODÈLE DE RÉSULTAT
        (poisson · statistique      (calibration 1X2)
         · xG · domicile/extérieur
         · forme — consensus pondéré)
                  │
                  ↓
        UNE DISTRIBUTION DE SCORES        ← source unique et unique seule
        P(h, a) pour h, a ∈ [0, 10]
                  │
      ┌───────────┼───────────┬──────────────┬─────────────┐
      ↓           ↓           ↓              ↓             ↓
   O/U 0.5-4.5  BTTS    BUTS PAR ÉQUIPE   SCORE EXACT   1X2 DÉRIVÉ
                                                              │
                                                     CALIBRATION 1X2
                                                     (T, c) ajustée
                                                     sur le passé
                                                              │
                                                         1X2 PUBLIÉ
```

### Les trois règles non négociables

1. **Une seule distribution de scores.** Tous les marchés en dérivent, sans exception.
2. **Le 1X2 est lu dans la distribution** (`Σ_{h>a}`, `Σ_{h=a}`, `Σ_{h<a}`), jamais moyenné à part.
3. **La couche de calibration est la seule transformation autorisée de la sortie 1X2**, et elle doit être documentée, publiée et surveillée.

### Ce qui a été testé et écarté

| Dispositif | Pourquoi il est écarté |
| --- | --- |
| **Hybride** : 1X2 sans xG + buts avec xG | Introduit 1,7 à 2,4 points de probabilité d'incohérence entre le 1X2 publié et la distribution, **et** publie un 1X2 moins bon (0,6009) que l'architecture cohérente (0,6006). Dominé. |
| **xG à 30-40 %** | Le gain sur les marchés de buts progresse de +0,0004 par palier de 10 % tandis que la dégradation du 1X2 progresse de +0,0007. Rendement décroissant, risque croissant. |
| **Supprimer le xG** | Le gain sur les marchés de buts est établi à tous les poids (P ≥ 0,98). Y renoncer serait refuser un gain mesuré. |
| **Calibration globale des marchés de buts** | Aide la ligne 2,5 (−0,0007) et le BTTS (−0,0008) mais **dégrade** la ligne 3,5 (+0,0008). À appliquer marché par marché, jamais globalement. |

---

## 3. Paramètres validés

### 3.1 Poids xG

| Paramètre | Valeur | Justification |
| --- | --- | --- |
| Poids a priori du modèle xG | **0,20** | Point de meilleur rendement ; poids le plus élevé pour lequel la dégradation du 1X2 n'est pas établie (P = 0,14) |
| Pondération temporelle du signal xG | **récence, demi-vie 3 matchs** | Domine le poids uniforme à poids égal : Δ1X2 +0,00121 contre +0,00179 ; ΔO/U −0,00151 contre −0,00103 ; ΔBTTS −0,00163 contre −0,00108 |
| Fenêtre d'historique xG | **toute la profondeur disponible** | Les fenêtres courtes (5 matchs) aggravent tout, jusqu'à +0,00340 sur le 1X2 avec intervalle excluant zéro |
| Nombre minimal d'observations | **3** (inchangé) | En dessous, le modèle est inapplicable et pèse 0 |

> Le poids effectif obtenu diffère du poids demandé : la confiance intrinsèque du modèle
> et sa divergence par rapport à la médiane des autres modèles le modulent. À 20 %
> demandés, le modèle pèse **19,6 %** en pratique. **Publier le poids effectif, jamais le poids demandé.**

### 3.2 Calibrateur 1X2

Calibrateur vectoriel : `q_i ∝ p_i^(1/T) · c_i`, avec `c_domicile = 1` fixé pour l'identifiabilité.

| Paramètre | Valeur ajustée | Stabilité mesurée |
| --- | --- | --- |
| Température T | **0,66** (récence 3 · 20 %) | 0,66 · 0,66 · 0,66 sur trois découpes d'ajustement — stable |
| Coefficient du nul c(nul) | **1,28** | 1,32 · 1,26 · 1,28 selon la période — stable |
| Coefficient extérieur c(ext) | **1,00** | 0,98 à 1,04 — sans effet notable |

**Interprétation :** T < 1 signifie que **le moteur aplatit ses probabilités** — il est trop
prudent. c(nul) > 1 signifie qu'**une fois affûté, il faut remonter la probabilité du nul**.

Cible d'ajustement recommandée en production : **une saison glissante complète**, réajustée
au plus une fois par saison. Validation hors échantillon obligatoire sur la saison suivante.

### 3.3 Calibrateurs des marchés binaires (facultatifs, marché par marché)

| Marché | T ajusté | Effet mesuré | À retenir ? |
| --- | --- | --- | --- |
| Over/Under 2,5 | 1,15 | −0,0007 | ✅ oui |
| BTTS | 1,21 | −0,0008 | ✅ oui |
| Over/Under 3,5 | 1,11 | **+0,0008** | ❌ non |

T > 1 sur ces marchés : ils sont **trop confiants**, à l'inverse du 1X2.

---

## 4. Invariants à préserver — et à tester

Ces invariants doivent tenir **à toutes les pondérations**, y compris 0 % et 40 %. Une
architecture qui ne serait cohérente qu'à un réglage précis ne serait pas une architecture.

| # | Invariant | Tolérance |
| --- | --- | --- |
| 1 | Somme de la distribution des scores | = 1 à 1e-9 |
| 2 | Somme du 1X2 (moyenné **et** dérivé) | = 1 à 1e-9 |
| 3 | 1X2 dérivé ≡ somme des scores correspondants | 1e-12 |
| 4 | P(Over N) ≡ masse des scores à N+1 buts et plus | 1e-9 |
| 5 | P(BTTS) ≡ masse des scores où les deux équipes marquent | 1e-9 |
| 6 | Buts par équipe ≡ masse des scores correspondants | 1e-9 |
| 7 | P(Over n) décroît avec n ; Over + Under = 1 | 1e-12 |
| 8 | **Non-contradiction** : si P(Over 2,5) varie, la masse des scores élevés varie **dans le même sens** | signe identique |
| 9 | P(BTTS) ≤ P(au moins 2 buts) ; ≤ P(Over 1,5) ; ≤ P(domicile marque) ; ≤ P(extérieur marque) | 1e-12 |
| 10 | Toute probabilité ∈ [0 ; 1], finie | — |

Les invariants 1 à 10 sont **déjà implémentés et verts** dans
`scripts/backtest/__tests__/coherence.test.ts` (9 tests). Ils portent aujourd'hui sur le
banc d'essai ; ils devront être **portés sur le moteur lui-même** au moment de l'implémentation.

**L'invariant 8 est le plus important** : c'est celui qui interdit exactement le scénario
que §14 de la phase 12 cherchait à prévenir — une probabilité d'Over qui monte pendant que
la distribution cesse de contenir les scores élevés correspondants.

---

## 5. Ordre d'implémentation recommandé

À exécuter **dans cet ordre**, chaque étape étant vérifiable indépendamment et réversible.

| Étape | Contenu | Risque | Gain mesuré |
| --- | --- | --- | --- |
| **1** | 1X2 dérivé de la distribution, **sans** calibration, **sans** changement de poids | **Faible** — aucune donnée nouvelle, aucun paramètre ajusté | −0,00026 à −0,00051 sur le 1X2 ; cohérence totale par construction |
| **2** | Poids xG du moteur : 0,20 → 0,20 **avec pondération par récence (demi-vie 3)** | Moyen — change la construction du signal xG | Δ1X2 moitié moindre, ΔBTTS et ΔO/U environ 1,5× meilleurs |
| **3** | Couche de calibration 1X2 (T, c), ajustée sur une saison glissante, validée hors échantillon | Moyen — paramètres ajustés à surveiller | −0,0016 |
| **4** | Calibration binaire sélective (O/U 2,5 et BTTS seulement) | Faible mais non universel | −0,0007 à −0,0008 |

**L'étape 1 est le repli sûr** : elle améliore le 1X2, rend la cohérence mathématique
gratuite, n'introduit aucun paramètre ajusté et ne dépend d'aucune donnée payante. Elle est
**immédiatement applicable** et réversible.

Chaque étape doit être activée derrière un drapeau de configuration, avec possibilité de
retour arrière sans redéploiement.

---

## 6. Qualité du xG — mention obligatoire

> **Le xG fourni par API Football Live est cohérent dans les données reçues, mais non vérifié par une seconde source indépendante.**

Cette mention **doit rester dans la documentation interne et dans l'interface
utilisateur** tant qu'un second fournisseur n'a pas recoupé les valeurs.

Éléments mesurés à l'appui :

- Aucune source gratuite ne publie de xG — vérifié : 132 colonnes, zéro colonne « xG ».
- Sur les statistiques **recoupables** (phase 10, 460 rencontres, 5 520 valeurs) : **1,63 % de divergence**, mais **deux biais directionnels** — sur les corners, c'est toujours la source historique qui en compte davantage (24 cas sur 24) ; sur les cartons jaunes, c'est toujours LiveFootballApi (40 cas sur 45). Un écart toujours orienté dans le même sens signale une différence de règle de comptage, pas un bruit.
- **26 statistiques** existent chez le fournisseur sans équivalent ailleurs — dont le xG. Elles ne sont vérifiables par personne d'autre que le fournisseur.

**Ce que cela implique :** toute probabilité affichée reposant sur le xG repose sur une
source unique. Ce risque est aujourd'hui **assumé explicitement**, il ne doit jamais être
présenté à l'utilisateur comme une donnée vérifiée.

---

## 7. Ce que cette architecture prépare

Les emplacements suivants sont prévus **sans qu'aucune donnée soit ajoutée aujourd'hui**.
Aucune variable ne sera introduite sans gain mesuré hors échantillon, sur le protocole de la
phase 12 (validation temporelle, intervalles de confiance appariés, sous-ensemble commun).

| Emplacement | Nature | Point d'insertion |
| --- | --- | --- |
| Blessures, suspensions | modulateur du modèle de buts | multiplicateur sur λ, borné |
| Compositions | modulateur du modèle de buts | idem |
| Météo, calendrier, fatigue, voyages | modulateur du modèle de buts | idem |
| Force de championnat | recalibrage inter-compétitions | paramètre de la couche de calibration |
| Données live | modèle de buts conditionnel | seconde distribution, à partir de la minute écoulée |

**Règle de recevabilité :** une variable n'entre que si elle améliore le Brier **et** ne
dégrade pas la calibration, sur des données postérieures à son ajustement, avec un
intervalle de confiance apparié excluant zéro. Aucune exception.

---

## 8. Limites connues de la validation

Ces limites doivent être relues avant toute implémentation.

1. **La calibration n'a été validée que sur une seule saison** (2025/2026, 760 rencontres). Les paramètres sont stables sur trois découpes d'ajustement, mais **le gain** n'a été mesuré qu'une fois.
2. **Le sous-ensemble xG ne couvre que 943 rencontres** sur 2 280, deux championnats, deux saisons. **LaLiga est sous-représentée** (80 rencontres payées) et dégrade systématiquement plus — sans qu'aucune cause ne soit établie.
3. **Le modèle A reste derrière le marché** : 0,6009 contre 0,5676 (cotes de clôture dé-marginalisées). Cette architecture **réduit l'écart**, elle ne le comble pas.
4. **Neuf configurations ont été comparées** sur le même jeu de données. Le risque de sélection existe. La décision repose sur le **signe constant** de l'effet à travers poids, championnats, périodes et marchés — jamais sur la meilleure ligne d'un tableau.
5. **Les écarts sont petits.** L'enjeu réel est architectural et honnête : des marchés qui ne se contredisent plus, des probabilités qui veulent dire ce qu'elles annoncent (ECE 2,34 → 1,64 pour la configuration xG), et un 1X2 qui n'est plus pénalisé par l'usage du xG.
6. **Aucune cause n'est établie** pour les trois concentrations d'erreur mesurées (matchs à 4 buts et plus, +0,0046 ; favori très net, +0,0062 ; match ouvert, +0,0029), ni pour les deux biais directionnels de la phase 10.

---

## 9. Interdits liés à cette architecture

1. **L'agent IA ne modifie jamais les probabilités.** Il explique, signale les données manquantes, justifie les changements de confiance. Le moteur statistique reste la source unique des probabilités.
2. **Aucune donnée inventée.** Statistique absente = « Donnée indisponible », jamais estimée.
3. **Aucun modèle présenté comme entraîné s'il ne l'est pas.** Les modèles s'appellent Poisson, Dixon-Coles, statistique, consensus, calibration. Jamais « IA entraînée ».
4. **Aucune variable ajoutée pour la complexité.** Chaque ajout doit passer le protocole de recevabilité du §7.
5. **Aucune recalibration rétroactive** des prédictions déjà publiées : l'historique est immuable.
6. **Aucun import massif** avant que la décision d'implémentation ne soit prise.

---

## 10. Références

| Élément | Emplacement |
| --- | --- |
| Rapport du backtest A/B (phase 11) | `reports/rapport-11-backtest-xg.md` |
| État du backtest (phase 11) | `reports/rapport-11-etat-backtest.md` |
| Architecture hybride (phase 12) | `reports/rapport-12-architecture-hybride.md` |
| Résultats chiffrés (phase 12) | `data/backtests/2026-09-29T23-43-15-138Z-phase12/phase12.json` |
| Rejeu par rencontre | `data/backtests/2026-09-29T23-43-15-138Z-phase12/records.jsonl` |
| Tests de cohérence | `scripts/backtest/__tests__/coherence.test.ts` — 9 tests |
| Calibrateurs | `scripts/backtest/calibration.ts` |
| Banc d'essai du consensus | `scripts/backtest/ensemble-lab.ts` |
| Banc d'essai phase 12 | `scripts/backtest/phase12.ts` — `npm run backtest:phase12`, 0 crédit |
| Comparaison des sources | `reports/rapport-comparaison-sources.md` |

---

## 11. Reproductibilité vérifiée

Le banc d'essai de la phase 12 a été exécuté deux fois avec le même script, à travers une
**reconstruction complète du bac à sable** — `node_modules` réinstallé, Node reinstallé,
base de données reprovisionnée. Les deux sorties sont **identiques caractère par caractère**,
horodatage exclu, y compris les intervalles de confiance bootstrap.

> Même graine, mêmes entrées, mêmes résultats. C'est la condition posée par §22 : une mesure
> qui ne serait pas reproductible ne serait pas une mesure.

Commande de vérification :

```bash
npm run backtest:phase12
# puis comparer les deux fichiers data/backtests/*-phase12/phase12.json
```
