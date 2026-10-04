# SOLEIL — Rapport de comparaison des sources

**Date :** 29 septembre 2026
**Phase :** 10 — « Comparaison des sources + validation du nouveau moteur »
**Statut :** comparaison terminée · **aucun import massif effectué** · 12 crédits consommés

---

## 1. Objet

Répondre à une seule question, avec des mesures : **LiveFootballApi (LFA) est-elle
meilleure que les sources actuelles ?** Et corollaire : **que faut-il garder ou
désactiver ?**

La comparaison porte sur les mêmes rencontres, vues par les deux sources.
Aucune source n'est supposée correcte : toute divergence est rapportée, aucune
n'est arbitrée.

| Source | Rôle | Coût |
| --- | --- | --- |
| football-data.co.uk | Source historique actuelle | **gratuit** |
| LiveFootballApi | Nouvelle source (API Football Live) | 1 crédit/appel (jamais épuisé) |
| TheSportsDB | Source secondaire existante | gratuit |

---

## 2. Périmètre et coût réel

| Élément | Valeur |
| --- | --- |
| Saison comparée | 2025/2026 (terminée) |
| Compétitions européennes | Premier League (E0), LaLiga (SP1) |
| Compétitions africaines | Togo — National Championship, Ghana — Premier League |
| Rencontres appariées | **760 sur 760** |
| Valeurs de résultat comparées | **6 080** |
| Rencontres à statistiques avancées | 8 (4 par compétition, réparties d'août à mai) |
| Valeurs avancées comparées | **96** |
| **Crédits phase 10** | **12** (4 périmètre de saison + 8 rencontres détaillées) |
| Solde clé 1 | **464 crédits restants** (relevé sur la réponse du fournisseur, 0 crédit dépensé) |
| Clés 2 à 18 | **0 appel** — la clé 1 reste la seule clé active, comme demandé |

Aucune écriture dans les tables métier. Les deux scripts sont en lecture seule et
produisent uniquement des rapports JSON dans `reports/`.

---

## 3. Méthode d'appariement (la règle qui change tout)

Deux rencontres ne sont **jamais** fusionnées parce que les noms se ressemblent.
L'appariement exige, dans l'ordre :

1. **date identique** (aucune tolérance : ±1 jour fusionnerait deux matchs quand
   un club joue deux fois dans la semaine) ;
2. **noms d'équipes identiques** après canonicalisation → confiance « exacte » ;
3. sinon **similarité ≥ 0,82 des deux côtés + score identique** → confiance
   « confirmée par le score » ;
4. plusieurs candidats possibles → classé **ambigu** et rapporté, jamais tranché ;
5. tout le reste → **non apparié**, et signalé comme tel.

### Défaut trouvé et corrigé grâce à cette mesure

La première version de la table d'alias visait des noms « officiels » que
**ni l'une ni l'autre** source n'utilise. Résultat : 342/380 rencontres
appariées en Premier League, **210/380 en Liga** — 170 rencontres Liga
« absentes » alors que les données étaient identiques.

Le diagnostic a montré que les deux sources abrègent différemment :

| football-data.co.uk | LiveFootballApi | Forme canonique retenue |
| --- | --- | --- |
| Ath Madrid | Atl. Madrid | atletico madrid |
| Sociedad | R. Sociedad | real sociedad |
| Celta | Celta Vigo | celta vigo |
| Vallecano | Rayo Vallecano | rayo vallecano |
| Oviedo | Real Oviedo | real oviedo |
| Espanol | Espanyol | espanyol |
| Nott'm Forest | Not. Forest | nottm forest |
| Man City / Man United | Man. City / Man. United | man city / man united |

La table canonique fait désormais converger **les deux** écritures vers une forme
commune. Après correction : **760/760 appariées, 0 ambiguë**.

---

## 4. Résultat 1 — Résultats de matchs (760 rencontres)

| Compétition | football-data.co.uk | LiveFootballApi | Appariées | Non appariées | Ambiguës | Divergences |
| --- | --- | --- | --- | --- | --- | --- |
| Premier League | 380 | 380 | **380** | 0 | 0 | **0** |
| LaLiga | 380 | 380 | **380** | 0 | 0 | **0** |

Valeurs comparées pour chaque rencontre : score domicile, score extérieur,
score mi-temps domicile, score mi-temps extérieur — plus date, équipes et
compétition, vérifiés par l'appariement lui-même.

**6 080 valeurs comparées · 0 divergence · confiance « exacte » sur 100 % des cas.**

### Couverture mi-temps — résultat important

Sur ces deux compétitions, **les deux sources publient le score à la mi-temps
pour 760 rencontres sur 760 (100 %)**. Cela confirme, en sens inverse, le
constat de l'audit §22 sur les compétitions africaines (Ghana 0,7 %, Togo 0 %).

Conséquence opérationnelle : le score à la mi-temps est exploitable pour les
compétitions européennes comparées ; il reste indisponible en Afrique, où
SOLEIL affichera `Score à la mi-temps : indisponible` — jamais une valeur
reconstituée.

---

## 5. Résultat 2 — Statistiques avancées (8 rencontres, 96 valeurs)

Échantillon déterministe : 4 rencontres par compétition, réparties régulièrement
sur toute la saison (15/08 → 24/05), pour ne pas se contenter des premières
journées.

| Date | Rencontre | Score | Source A | LFA |
| --- | --- | --- | --- | --- |
| 2025-08-15 | Liverpool – Bournemouth | 4-2 | 4-2 | 4-2 |
| 2025-11-30 | Aston Villa – Wolves | 1-0 | 1-0 | 1-0 |
| 2026-02-10 | West Ham – Man United | 1-1 | 1-1 | 1-1 |
| 2026-05-24 | West Ham – Leeds | 3-0 | 3-0 | 3-0 |
| 2025-08-15 | Girona – Rayo Vallecano | 1-3 | 1-3 | 1-3 |
| 2025-11-23 | Betis – Girona | 1-1 | 1-1 | 1-1 |
| 2026-02-28 | Real Oviedo – Atl. Madrid | 0-1 | 0-1 | 0-1 |
| 2026-05-24 | Villarreal – Atl. Madrid | 5-1 | 5-1 | 5-1 |

### Tableau des divergences

| Match | Statistique | Source A | API Football Live | Écart |
| --- | --- | --- | --- | --- |
| *aucune* | *aucune* | — | — | — |

Aucune ligne : **0 divergence sur 96 valeurs comparables.**

| Statistique | Valeurs comparables | Divergences | Écart moyen | Écart max |
| --- | --- | --- | --- | --- |
| Tirs | 16 | **0** | 0 | 0 |
| Tirs cadrés | 16 | **0** | 0 | 0 |
| Corners | 16 | **0** | 0 | 0 |
| Fautes | 16 | **0** | 0 | 0 |
| Cartons jaunes | 16 | **0** | 0 | 0 |
| Cartons rouges | 16 | **0** | 0 | 0 |

### Vérification de la puissance discriminante

Un accord parfait peut aussi signifier que la comparaison ne compare rien.
Contrôle effectué : deux rencontres de Liga comportent un carton rouge
(Girona–Rayo Vallecano et Betis–Girona). football-data.co.uk annonce `1/0`.
**LFA annonce aussi `1/0`.** La comparaison détecte donc bien les valeurs non
nulles — l'accord est réel, pas un artefact.

Ordre de grandeur des valeurs confrontées : tirs 7 à 23, corners 0 à 9,
fautes 3 à 21, cartons jaunes 0 à 4.

### Robustesse de la normalisation

Sur les 10 rencontres détaillées disponibles, **32 libellés statistiques sur 32
sont reconnus** par le vocabulaire canonique. Un seul libellé restait non
reconnu (`Running Distance`, observé 4 fois) : il est désormais mappé, sans être
utilisé comme variable du modèle.

---

## 6. Ce que LFA apporte — et ce que cela ne prouve pas

LFA publie **23 statistiques sans équivalent** dans la source actuelle :

> xG · xG sur coups de pied arrêtés · possession · grosses occasions manquées ·
> tirs non cadrés · tirs contrés · passes totales · passes réussies · précision de
> passe · centres · duels gagnés · duels aériens gagnés · tacles réussis ·
> dribbles réussis · dégagements · interceptions · touches dans la surface ·
> poteaux · touches · coups de pied de but · hors-jeu · PPDA passes ·
> PPDA actions défensives

xG relevé sur 10 rencontres (LFA uniquement — **aucun point de comparaison**,
donc **non validé à ce stade**) :

| Rencontre | xG domicile | xG extérieur |
| --- | --- | --- |
| Liverpool – Bournemouth | 2,21 | 1,70 |
| Aston Villa – Wolves | 0,94 | 0,40 |
| West Ham – Man. United | 1,10 | 0,57 |
| West Ham – Leeds United | 2,61 | 1,59 |
| Girona – Rayo Vallecano | 0,56 | 3,43 |
| Betis – Girona | 1,42 | 1,78 |
| Real Oviedo – Atl. Madrid | 1,16 | 0,75 |
| Villarreal – Atl. Madrid | 2,48 | 1,16 |
| USVI – Bahamas *(hors échantillon)* | 0,90 | 1,11 |
| Jamaïque – Guatemala *(hors échantillon)* | 1,66 | 2,99 |

**Limite explicite :** la source actuelle ne publie pas de xG. Le xG de LFA ne
peut donc **pas** être validé par cette comparaison. Il faudra soit un second
fournisseur de xG, soit la validation indirecte par le backtest (question 2,
section 10).

---

## 7. Source Quality Score

Quatre axes demandés. Deux sont mesurables immédiatement ; les deux autres
exigent deux relevés espacés dans le temps — ils sont déclarés **non mesurés**,
pas estimés.

| Axe | football-data.co.uk | LiveFootballApi |
| --- | --- | --- |
| **Complétude** | **100 %** | **100 %** |
| **Cohérence** (avec l'autre source) | **100 %** (6 080 valeurs) | **100 %** (6 080 valeurs) |
| **Fraîcheur** | Non mesurable : fichier de saison statique, aucun horodatage de publication | Mesurable : la réponse porte `timestamp`, `last_updated` et un champ `stale` par rencontre |
| **Stabilité** | Non mesurée — protocole défini : deux relevés espacés, détection des variations anormales | Non mesurée — même protocole |
| **Score (2 axes sur 4)** | **100 / 100** | **100 / 100** |

**Lecture honnête :** sur le terrain commun, les deux sources sont à égalité.
Rien, dans ces mesures, ne permet de déclarer LFA « supérieure » sur ce qu'elles
partagent toutes les deux. L'avantage de LFA est ailleurs, et il est factuel :

1. elle fournit **23 statistiques de plus**, dont le xG ;
2. elle couvre les **compétitions africaines** que l'autre source ignore ;
3. elle fournit les **rencontres à venir** (l'autre source ne les expose pas :
   capacité `fixtures: false`) ;
4. elle documente sa **fraîcheur** (l'autre ne le fait pas).

---

## 8. Compétitions africaines — comparaison impossible, et c'est un résultat

football-data.co.uk **ne couvre ni le Togo ni le Ghana**. Il n'existe donc aucun
point de comparaison : les chiffres ci-dessous reposent sur **LFA seule**.

| Compétition | Rencontres | Complétude | Score mi-temps |
| --- | --- | --- | --- |
| Togo — National Championship 2025/2026 | 182 | 80 % | **0 %** |
| Ghana — Premier League 2026/2027 | 306 | 62,4 % | **0,7 %** |

**Conséquence à assumer :** pour l'Afrique, LFA n'est pas « meilleure », elle est
**la seule source**. Aucune vérification croisée n'est possible : une erreur de
LFA y serait indétectable. Cette donnée doit être affichée comme telle dans
l'application (niveau de qualité de donnée, jamais une confiance élevée).

Deux autres constats de l'audit §22 sont confirmés ici : le score à la mi-temps
est absent en Afrique, et les saisons annoncées peuvent être vides (Togo
2026/2027, Sénégal) → affichage `Saison annoncée — données non encore publiées
par le fournisseur.`

---

## 9. Traçabilité des crédits — et un défaut corrigé

**Dépense de la phase 10 : 12 crédits**, tous sur la **clé 1**.

| Poste | Appels | Crédits |
| --- | --- | --- |
| Saison complète E0 (380 rencontres) | 1 | 1 |
| Saison complète SP1 (380 rencontres) | 1 | 1 |
| Togo 2025/2026 (182 rencontres) | 1 | 1 |
| Ghana 2026/2027 (306 rencontres) | 1 | 1 |
| Statistiques avancées (8 rencontres) | 8 | 8 |
| **Total phase 10** | **12** | **12** |

**Coût réel par match analysé :**

| Niveau d'analyse | Coût |
| --- | --- |
| Résultat + mi-temps (une saison de 380 rencontres) | 1 crédit → **0,0026 crédit/match** |
| Résultat + mi-temps + 32 statistiques + événements (match analysé à fond) | **1 crédit/match** |

### Défaut de traçabilité trouvé — corrigé

Les 36 appels journalisés aujourd'hui avaient tous `quotaAfter` **vide** en base.
Cause : le client lisait le solde dans les **en-têtes HTTP**, alors que
LiveFootballApi le publie dans le **corps** de la réponse (`credits_remaining`).
Conséquence : l'API CREDIT MONITOR demandé en phase 10 était **aveugle** — il ne
pouvait afficher aucun « crédits restants ».

Correction : le corps est désormais lu avant l'enregistrement, et le solde réel
est persisté (`ApiCallLog.quotaAfter`, `ApiCredential.dailyRemaining`).
7 tests protègent la correction (dont : un solde absent reste `null`, jamais une
estimation ; `0 crédit` est conservé comme mesure). **110 tests au vert** dans
le projet.

> Le solde de 464 crédits de ce rapport a d'ailleurs été relevé **sans dépenser
> un crédit**, en relisant les réponses déjà en cache.

---

## 10. Réponse aux questions posées — état à ce jour

| Question | Réponse | Statut |
| --- | --- | --- |
| 1. LFA est-elle meilleure que les sources actuelles ? | **À égalité sur le terrain commun** (0 divergence sur 6 176 valeurs), **strictement plus riche en dehors** (xG, 23 statistiques, Afrique, matchs à venir, fraîcheur documentée) | **Répondu** |
| 2. Le xG améliore-t-il réellement SOLEIL ? | **Non démontré à ce stade.** Aucun point de comparaison xG, et aucun backtest exécuté | **En attente du backtest** |
| 3. Quelles statistiques avancées améliorent le modèle ? | Non mesuré — protocole V1→V5 défini, non exécuté | **En attente** |
| 4. Quelle combinaison est la meilleure ? | Non mesuré | **En attente** |
| 5. Coût réel par match analysé ? | **1 crédit** (analyse complète) · 0,0026 crédit/match pour les résultats d'une saison | **Répondu** |
| 6. Quelle architecture de données conserver ? | Conserver les trois sources : la comparaison **a besoin** de football-data.co.uk comme contre-référence. Aucune suppression | **Répondu** |
| 7. Quelles données laisser désactivées ? | Rien à désactiver à ce stade : les 23 statistiques supplémentaires sont **collectées mais pas encore utilisées** par le modèle. Décision après backtest | **Répondu provisoirement** |

---

## 11. Ce que ce rapport ne prouve pas

À lire avant toute conclusion :

1. **L'échantillon avancé est petit** : 8 rencontres, 2 compétitions. Un taux de
   divergence de 0 % sur 96 valeurs ne garantit pas 0 % sur 380 rencontres ; il
   exclut seulement les erreurs grossières et fréquentes.
2. **Le xG n'est pas validé** : aucune contre-référence, aucun backtest.
3. **Fraîcheur et stabilité non mesurées** : elles exigent deux relevés espacés.
4. **L'Afrique n'a aucun contrôle croisé** : LFA y est seule, donc non vérifiable.
5. **Les événements, compositions, blessures, H2H ne sont pas comparés ici** —
   l'audit §22 les a documentés, mais sans contre-référence.
6. **Comparaison limitée à 2 compétitions européennes** : ni l'Allemagne,
   l'Italie, la France, ni les coupes d'Europe ni l'AFCON n'ont été comparées.
   Aucune compétition n'a été forcée dans l'échantillon.
7. **Le multi-clés n'est pas validé** : le fournisseur ne documente pas la
   mutualisation de 18 comptes, et la limite de 2 req/s est par IP. Une seule clé
   reste active.

---

## 12. Conclusion et suite

La comparaison demandée est **terminée** : 760 rencontres, 6 080 valeurs de
résultat et 96 valeurs de statistiques avancées, **0 divergence**, pour
**12 crédits**.

**Décision proposée :** LFA peut devenir **source principale de collecte** — les
deux sources étant en accord parfait sur le terrain commun, remplacer ne fait
perdre aucune information, et LFA ajoute ce que l'autre n'a pas. Mais
**« principale » ne veut pas dire « crue »** : la règle « ne jamais fusionner sur
une ressemblance de noms » et le contrôle croisé restent en place.

**En revanche, aucune intégration dans le moteur de prédiction n'est justifiée
avant le backtest.** Le xG, la possession et les grosses occasions sont
collectés ; ils ne seront utilisés que si le gain hors échantillon est mesuré.

Ordre qui reste à exécuter :

1. **API CREDIT MONITOR** — débloqué par la correction de traçabilité ;
2. **backtest A/B « sans xG » contre « avec xG »**, même jeu de données, même
   protocole temporel (Brier, Log Loss, calibration, exactitude) ;
3. **backtests progressifs V1 → V5** avec tests d'étanchéité (*leakage*),
4. **rapport Togo**, test de l'endpoint des matchs à venir,
5. **filtre qualité publier / rejeter** avant toute mise en ligne.

Aucun import massif n'a été lancé, et aucun ne doit l'être avant l'étape 2.

---

### Artefacts

| Fichier | Contenu |
| --- | --- |
| `reports/comparaison-sources-2026-09-29T22-21-36-628Z.json` | Comparaison de saison (760 rencontres) |
| `reports/comparaison-avancee-2026-09-29T22-23-50-781Z.json` | Comparaison des statistiques avancées (8 rencontres) |
| `scripts/compare-sources.ts` — `npm run compare` | Outil de comparaison de saison (0 crédit après mise en cache) |
| `scripts/compare-advanced.ts` — `npm run compare:advanced` | Outil de comparaison avancée (1 crédit/rencontre, plafond auto-ajusté) |
| `scripts/lib/source-matching.ts` | Appariement canonique partagé par les deux outils |
| `src/server/data/providers/apiFootballLive/__tests__/client-quota.test.ts` | 7 tests sur le suivi des crédits |
