# SOLEIL — PHASE 11 · Backtest A/B : état d'avancement et chiffrage

**Date :** 29 septembre 2026
**Statut :** appareil de mesure terminé et prouvé · **partie B (xG) non exécutable sans dépense de crédits** · **0 crédit dépensé dans cette phase à ce stade**

---

## 1. Ce qui est construit et vérifié

| Élément | État | Preuve |
| --- | --- | --- |
| Pare-feu temporel (§2) | **Vérifié** | 10 tests automatisés, dont tests de mutation |
| Fidélité du harnais au moteur (§1, §16) | **Vérifié** | sorties identiques à 1 × 10⁻⁹ près |
| Dataset persisté et versionné (§21) | **Fait** | `data/raw`, `data/normalized`, `data/features`, `data/backtests` |
| Reproductibilité (§22) | **Fait** | manifeste + graine + empreintes SHA-256 |
| Métriques (§10, §11, §14, §15) | **Fait** | Brier, Log Loss, calibration, score exact, masses |
| Robustesse (§13) | **Fait** | par compétition, par saison, par période, intervalles appariés |
| Modèle A (baseline) | **Mesuré** | 2 280 rencontres de test |
| Contrôles gratuits (tirs, tirs cadrés) | **Mesuré** | 2 280 rencontres de test |
| Modèle B et variantes xG | **BLOQUÉ** | le xG n'existe que chez LiveFootballApi (payant) |

### La preuve anti-fuite (§2), en une phrase

Le test de mutation modifie **tout le futur** (scores absurdes, xG énormes, mi-temps inventées) et exige que le contexte de prédiction reste **bit à bit identique** ; il modifie ensuite **le passé** et exige qu'il **change**. Sans la seconde moitié du test, une fonction renvoyant un contexte vide passerait la première.

Cas explicitement interdit en phase 10 et couvert :

> « ne jamais prédire Arsenal–Chelsea en utilisant les xG de ce match »

Le test `MUTATION DU MATCH CIBLE` remplace le score et les xG de la rencontre cible par des valeurs absurdes : le contexte ne bouge pas.

---

## 2. Protocole (§5, §6)

| Paramètre | Valeur |
| --- | --- |
| Source | football-data.co.uk — **gratuite**, 0 crédit |
| Historique chargé | 2015/2016 → 2025/2026 (11 saisons, 4 180 rencontres par ligue) |
| Saisons de test | 2023/2024, 2024/2025, 2025/2026 |
| **Rencontres de test** | **2 280** (1 140 Premier League + 1 140 LaLiga) |
| Validation | temporelle glissante, **aucun tirage aléatoire** |
| Historique par équipe | 40 rencontres strictement antérieures |
| Audit anti-fuite | 120 contextes vérifiés pendant l'exécution → **0 fuite** |

---

## 3. Modèle A — baseline mesurée (2 280 rencontres)

### 1X2

| Indicateur | Valeur |
| --- | --- |
| Brier | **0,5945** |
| Log Loss | **0,9972** |
| ECE (calibration) | **2,42 points de probabilité** |

### Tous les marchés

| Marché | Brier | Log Loss |
| --- | --- | --- |
| Over/Under 0,5 | 0,0502 | — |
| Over/Under 1,5 | 0,1680 | — |
| **Over/Under 2,5** | **0,2431** | — |
| Over/Under 3,5 | 0,2075 | — |
| Over/Under 4,5 | 0,1300 | — |
| Buts domicile 0,5 / 1,5 / 2,5 | 0,1594 / 0,2287 / 0,1543 | — |
| Buts extérieur 0,5 / 1,5 / 2,5 | 0,1944 / 0,2179 / 0,1071 | — |
| **BTTS** | **0,2463** | 0,6858 |
| 1re mi-temps — lignes 0,5 / 1,5 / 2,5 | 0,2008 / 0,2254 / 0,1101 | — |
| 1 but ou plus en 1re mi-temps | 0,2008 | — |

### Score exact (§14, §15)

| Indicateur | Valeur |
| --- | --- |
| Log Loss | **2,9122** |
| Probabilité moyenne donnée au score réel | **7,01 %** |
| Top 1 | **14,1 %** |
| Top 3 | 33,4 % |
| Top 5 | 49,7 % |
| Somme de la distribution | **1,000000** ✔ (§15) |

**Lecture sans complaisance :** un top-1 à 14,1 % signifie qu'en annonçant le score le plus probable, SOLEIL a raison **une fois sur sept**. C'est la réalité de ce marché ; la Log Loss de 2,91 et la probabilité moyenne de 7 % disent la même chose. Le score exact reste intrinsèquement incertain.

### Par compétition et par saison

| Périmètre | n | Brier 1X2 | ECE |
| --- | --- | --- | --- |
| Premier League | 1 140 | 0,5983 | 1,72 pt |
| LaLiga | 1 140 | 0,5907 | 3,11 pts |
| Saison 2023/2024 | 760 | 0,5793 | 3,23 pts |
| Saison 2024/2025 | 760 | 0,5918 | 2,73 pts |
| Saison 2025/2026 | 760 | **0,6124** | 1,69 pt |

La dégradation en 2025/2026 (−0,02 de Brier par rapport à 2023/2024) est mesurée, pas interprétée : aucune cause n'est avancée ici faute de preuve.

---

## 4. Référence de marché — le mètre étalon

Les cotes de clôture (**gratuites**) sont dé-marginalisées et servent de **référence**, jamais d'entrée au modèle.

| Modèle | Brier 1X2 | Log Loss 1X2 |
| --- | --- | --- |
| **Marché (cotes de clôture)** | **0,5676** | **0,9567** |
| SOLEIL — Modèle A | 0,5945 | 0,9972 |
| Écart | **+0,0269** | +0,0405 |

SOLEIL est donc **à 4,7 % du marché** en Brier. C'est la marge de progression réelle. Tout gain apporté par le xG se jugera sur cette échelle, pas dans l'absolu.

---

## 5. Premier résultat mesuré : les contrôles gratuits

Deux variantes **entièrement gratuites** ont été testées : attaque/défense estimées sur les **tirs** (C1) et sur les **tirs cadrés** (C2), à la place du xG. Elles utilisent exactement la même mécanique que le futur modèle xG.

| Modèle | Brier 1X2 | Δ vs A | IC 95 % (apparié) | O/U 2,5 | BTTS |
| --- | --- | --- | --- | --- | --- |
| A — sans signal | 0,5945 | — | — | 0,2431 | 0,2463 |
| C1 — tirs | 0,5978 | **+0,00328** | **[+0,0018 ; +0,0049]** | 0,2425 | 0,2457 |
| C2 — tirs cadrés | 0,5974 | **+0,00289** | **[+0,0015 ; +0,0044]** | 0,2426 | 0,2456 |

**Résultat :** introduire un signal sur les tirs **dégrade significativement le 1X2** (l'intervalle de confiance exclut zéro, et l'effet est du même signe dans les deux championnats et les deux moitiés de saison). En revanche, elle améliore très légèrement l'Over/Under 2,5 (−0,0007) et le BTTS (−0,0006).

Deux enseignements que le test du xG devra confirmer ou infirmer :

1. **Le moteur n'a pas besoin qu'on lui ajoute un signal de volume** : il dégrade le 1X2. Un signal redondant pèse 20 % dans le consensus et déplace les intensités sans apporter d'information neuve.
2. **Les marchés de buts réagissent différemment du 1X2.** §24 s'annonce donc décisif : la réponse sera probablement « le xG améliore tel marché et pas tel autre », pas « le xG est meilleur ».

---

## 6. Le blocage : le xG coûte 1 crédit par rencontre

Vérifié le 29/09/2026 : football-data.co.uk publie **132 colonnes** — résultats, tirs, fautes, cartons, cotes — et **aucune colonne xG**. TheSportsDB n'en publie pas non plus. Le xG n'existe que chez **LiveFootballApi**, à **1 crédit par rencontre**.

Un backtest exige le xG de chaque rencontre **de test** *et* de son **historique** (les séries glissantes). Coût par scénario, calculé exactement (aucun crédit dépensé, lecture des datasets locaux) :

### Solde actuel : **464 crédits** sur la clé 1 · clés 2 à 18 : **8 536 crédits, jamais utilisés**

| Option | Coût | Reste sur clé 1 | Rencontres de test exploitables | Verdict |
| --- | --- | --- | --- | --- |
| **A — Premier League seule** (2024/2025 enrichie) | **380** | 84 | **272** (fenêtre ≥3) · 221 (≥10) · 150 (≥20) | Un seul championnat : la robustesse inter-championnats (§13) n'est pas vérifiable |
| **B — Premier League + LaLiga** (2024/2025 enrichies) | **760** | **−296** → clé 2 requise pour 296 appels | **544** (≥3) · 443 (≥10) · 301 (≥20) | Protocole complet, toutes les variantes, fenêtres jusqu'à 38 matchs |
| **C — E0 complète + LaLiga partielle** (8 dernières journées) | **460** | 4 | 272 + 272, **mais LaLiga plafonnée à des fenêtres ≤ 8** | Deux compétitions, dont une aux fenêtres trop courtes pour les variantes 10/20 |
| D — E0 sur deux saisons (2023/2024 + 2024/2025) | 760 | −296 → clé 2 requise | 306 (≥3) · 249 (≥10) · 169 (≥20) | Un championnat, stabilité temporelle renforcée |

**Prérequis, quel que soit le choix :** un **pilote de 4 crédits** — 1 appel `/league_fixtures` sur la saison 2024/2025 et 3 appels `/live_match_details` sur des rencontres anciennes — pour vérifier que le fournisseur publie bien le xG sur des matchs **de la saison passée**. L'audit §22 l'a confirmé sur des matchs récents ; il ne l'a pas confirmé sur l'historique. Mieux vaut le savoir avec 4 crédits qu'après 380.

---

## 7. Recommandation

**Option A, puis décision.** Le protocole A fournit 272 rencontres exploitables avec des fenêtres pleines sur un championnat, pour 380 crédits, et laisse 84 crédits de marge. Si le xG améliore réellement les prédictions, l'extension à LaLiga (option B) se décidera sur un résultat, pas sur une intuition — et les 380 crédits déjà engagés resteront valables, puisqu'ils resteront en cache.

L'option B est scientifiquement la plus forte (deux championnats, 544 rencontres, contrôle croisé complet) mais elle consomme 296 crédits de la clé 2, ce que la règle « clé 1 uniquement » interdit sans votre autorisation explicite.

**Rappel de la règle en vigueur :** aucune rotation automatique n'est implémentée, aucun appel n'a jamais touché les clés 2 à 18, et cette phase n'a dépensé **aucun crédit**.

---

## 8. Ce qui suivra immédiatement après l'autorisation

1. Pilote 4 crédits → vérification du xG sur matchs anciens.
2. Enrichissement de la saison retenue (1 crédit/rencontre, journalisé : crédits avant/après, endpoint, nombre d'appels).
3. Écriture du dataset enrichi dans `data/features/` (persistant, versionné).
4. Exécution du backtest complet : Modèle A contre Modèle B et les 8 variantes xG, sur les mêmes rencontres, avec intervalles de confiance appariés.
5. Rapport final (§23) : par marché, par compétition, par période — et décision technique (§24) : où le xG améliore, où il ne change rien, où il détériore.

**Aucun import massif ne sera lancé.** La séquence reste : audit → comparaison → **backtest** → validation → intégration.
