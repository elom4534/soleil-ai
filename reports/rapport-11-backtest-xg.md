# SOLEIL — PHASE 11 · RAPPORT FINAL DU BACKTEST A/B

## « Le xG améliore-t-il réellement les prédictions pré-match de SOLEIL, et dans quels marchés ? »

**Date :** 29 septembre 2026
**Crédits dépensés dans cette phase : 462** (clé 1 uniquement) · **solde restant : 2 crédits** · clés 2 à 18 : **jamais utilisées**
**Aucun import massif lancé.** Le moteur de production n'a pas été modifié.

---

## RÉPONSE EN UNE PHRASE

**Le xG améliore les marchés de buts (Over/Under, BTTS, buts par équipe, score exact) de façon faible mais robuste — et il DÉTÉRIORE le 1X2.** Il ne doit donc pas être utilisé comme un signal global, mais uniquement là où le gain est mesuré.

---

# 1 · DATASET

| Élément | Valeur |
| --- | --- |
| **Rencontres chargées (gratuit)** | 8 360 — Premier League et LaLiga, saisons 2015/2016 → 2025/2026 |
| **Rencontres de test** | **2 280** (1 140 Premier League + 1 140 LaLiga) |
| **Périodes de test** | 2023/2024, 2024/2025, 2025/2026 |
| **Rencontres enrichies en xG (payant)** | **460** : Premier League 2024/2025 complète (380) + LaLiga 2024/2025, 8 dernières journées (80) |
| **Couverture xG obtenue** | **100 %** — 460/460 rencontres avec xG des deux côtés |
| **Coût** | **462 crédits** (460 rencontres + 2 appels de cadrage `/league_fixtures`) |
| **Sous-ensemble où le xG peut agir** | **943 rencontres** (622 Premier League, 321 LaLiga ; 399 en 2024/2025, 544 en 2025/2026) |

**Pourquoi 943 et non 2 280 :** le modèle xG ne s'active que si l'historique des deux équipes contient déjà au moins 3 rencontres avec xG. Sur les rencontres de 2023/2024 (aucun xG payé), il est **inapplicable** — donc le Modèle B y est rigoureusement identique au Modèle A. Inclure ces rencontres diluerait l'effet mesuré vers zéro. Les deux périmètres sont publiés : **2 280** (réalité de production) et **943** (le signal a pu agir).

### Protocole

| Règle | Application |
| --- | --- |
| Validation temporelle (§5) | Aucun tirage aléatoire. Chaque rencontre est prédite depuis les seules rencontres **strictement antérieures** |
| Historique par équipe | 40 rencontres antérieures, fenêtre glissante |
| Étanchéité (§2) | **10 tests automatisés**, dont tests de mutation · **120 contextes audités** pendant l'exécution → **0 fuite** |
| Fidélité au moteur (§1, §16) | Le harnais reproduit les marchés du moteur à **1 × 10⁻⁹** près, mi-temps et score exact compris |
| Reproductibilité (§22) | Graine fixe, manifeste, empreintes SHA-256, fichier de rejeu par rencontre et par modèle |

### Ce qu'aucun modèle n'a jamais vu

Le test de mutation remplace **tout le futur** (scores absurdes, xG énormes, mi-temps inventées) et exige un contexte **bit à bit identique** ; il remplace ensuite **le match cible lui-même** (score 8-0, xG 4,4) et exige toujours le même contexte ; il modifie enfin **le passé** et exige qu'il change. Les trois propriétés sont vérifiées automatiquement à chaque exécution de `npm test`.

---

# 2 · BASELINE (Modèle A — moteur actuel, sans xG)

### Sur les 2 280 rencontres de test

| Marché | Brier | Log Loss | Calibration (ECE) |
| --- | --- | --- | --- |
| **1X2** | **0,5945** | **0,9972** | **2,42 points de probabilité** |
| Over/Under 2,5 | 0,2431 | — | — |
| BTTS | 0,2463 | 0,6858 | — |
| Score exact | — | **2,9122** | top-1 : 14,1 % · top-3 : 33,4 % · top-5 : 49,7 % |
| Somme de la distribution des scores | **1,000000** ✔ (§15) | | |

**Référence de marché** (cotes de clôture dé-marginalisées, mêmes rencontres) : Brier 1X2 **0,5676** · Log Loss **0,9567**. SOLEIL baseline est donc à **+0,0269 de Brier** du marché.

### Sur le sous-ensemble où le xG peut agir (943 rencontres)

| Marché | Brier |
| --- | --- |
| 1X2 | 0,6009 |
| Over/Under 2,5 | 0,2461 |
| BTTS | 0,2480 |
| Score exact | Log Loss 2,9076 |

---

# 3 · MODÈLE + xG

### Sur les 2 280 rencontres (réalité de production : xG disponible seulement en partie)

| Modèle | Brier 1X2 | Log Loss | ECE | O/U 2,5 | BTTS |
| --- | --- | --- | --- | --- | --- |
| A — sans xG | **0,5945** | **0,9972** | **2,42** | 0,2431 | 0,2463 |
| **B — moteur + xG** | 0,5952 | 0,9983 | 2,95 | 0,2427 | **0,2458** |

### Sur les 943 rencontres où le xG agit réellement

| Modèle | Brier 1X2 | O/U 2,5 | BTTS | Score exact (LL) | ECE |
| --- | --- | --- | --- | --- | --- |
| A — sans xG | **0,6009** | 0,2461 | 0,2480 | 2,9076 | **2,42** |
| **B — moteur + xG** | 0,6027 | **0,2450** | **0,2470** | **2,9036** | 3,55 |
| B8 — xG + récence + domicile/extérieur | 0,6017 | 0,2462 | 0,2486 | 2,9178 | 3,15 |
| C2 — tirs cadrés (gratuit, contrôle) | 0,6028 | 0,2462 | 0,2481 | 2,9061 | 3,47 |

---

# 4 · DIFFÉRENCE (intervalles de confiance appariés, 943 rencontres)

| Marché | Δ Brier (B − A) | IC 95 % | Probabilité que B soit meilleur |
| --- | --- | --- | --- |
| **1X2** | **+0,00179 (détérioration)** | [−0,00030 ; +0,00385] | **5 %** |
| **Over/Under 2,5** | **−0,00103 (amélioration)** | [−0,00209 ; −0,00005] | **98 %** |
| **BTTS** | **−0,00108 (amélioration)** | [−0,00189 ; −0,00029] | **99 %** |

**Lecture :** sur le 1X2, l'intervalle de confiance frôle le zéro par le haut — la détérioration est *probable* (95 %) mais de faible amplitude. Sur l'Over/Under et le BTTS, l'intervalle **exclut le zéro** : le gain est réel, mais petit (environ **un millième de Brier**).

---

# 5 · PAR MARCHÉ (943 rencontres, mêmes rencontres pour les deux modèles)

| Marché | Modèle A | + xG (moteur) | Δ | Verdict |
| --- | --- | --- | --- | --- |
| **1X2** | **0,6009** | 0,6027 | **+0,00179** | ❌ détériore |
| Total > 0,5 | 0,0434 | 0,0433 | −0,00011 | ≈ neutre |
| Total > 1,5 | 0,1649 | 0,1642 | −0,00072 | ✅ améliore |
| **Total > 2,5** | 0,2461 | 0,2450 | **−0,00103** | ✅ améliore |
| **Total > 3,5** | 0,2076 | 0,2059 | **−0,00162** | ✅ meilleur gain |
| Total > 4,5 | 0,1240 | 0,1230 | −0,00099 | ✅ améliore |
| Buts domicile > 0,5 / 1,5 / 2,5 | 0,1672 / 0,2351 / 0,1538 | 0,1669 / 0,2350 / 0,1537 | −0,00035 / −0,00010 / −0,00008 | ≈ faible |
| Buts extérieur > 0,5 / 1,5 / 2,5 | 0,1858 / 0,2252 / 0,0997 | 0,1852 / 0,2245 / 0,0988 | −0,00058 / −0,00070 / −0,00083 | ✅ léger |
| **BTTS** | 0,2480 | 0,2470 | **−0,00108** | ✅ améliore |
| 1re mi-temps > 0,5 / 1,5 / 2,5 | 0,1950 / 0,2266 / 0,1157 | 0,1949 / 0,2258 / 0,1155 | −0,00009 / −0,00080 / −0,00021 | ✅ très léger |
| 1re mi-temps ≥ 1 but | 0,1950 | 0,1949 | −0,00010 | ≈ neutre |
| **Score exact (Log Loss)** | 2,9076 | **2,9036** | **−0,00400** | ✅ léger |

**Constat structurant :** le xG n'améliore **jamais** le 1X2, et améliore **tous** les marchés de buts. Le gain croît avec la ligne d'Over/Under (maximal sur 3,5). Le signal xG apporte donc de l'information sur **le volume de buts attendu**, pas sur **l'issue** du match.

---

# 6 · VARIANTES TESTÉES (§17)

Aucune variante n'est écartée du rapport. Fenêtres 5 / 10 / 20, pondération par récence, découpage domicile/extérieur. **Chaque variante est jugée sur son propre périmètre applicable** (les rencontres où son signal existe) — le nombre de rencontres diffère donc d'une ligne à l'autre, et c'est indiqué.

### 6a · Chaque variante sur son périmètre applicable

| Variante | n | 1X2 Δ | O/U 2,5 Δ | BTTS Δ | ECE |
| --- | --- | --- | --- | --- | --- |
| B1 — toute la profondeur (moteur actuel) | 943 | +0,00179 | −0,00103 | −0,00108 | 3,55 |
| B2 — 5 derniers matchs | 442 | **+0,00340** | −0,00124 | −0,00062 | 4,32 |
| B3 — 10 derniers matchs | 516 | +0,00250 | −0,00141 | −0,00113 | 4,84 |
| B4 — 20 derniers matchs | 655 | +0,00222 | −0,00090 | −0,00075 | **5,30** |
| B5 — pondération par récence (demi-vie 6) | 943 | +0,00139 | −0,00130 | −0,00140 | 3,69 |
| **B6 — pondération par récence (demi-vie 3)** | 943 | **+0,00121** | **−0,00151** | **−0,00163** | 3,60 |
| B7 — domicile/extérieur | 841 | +0,00120 | −0,00121 | −0,00087 | 3,12 |
| **B8 — domicile/extérieur + récence** | 841 | **+0,00096** | −0,00132 | −0,00106 | 3,15 |
| C1 — tirs (gratuit) | 2 271 | +0,00329 | −0,00066 | −0,00059 | 3,68 |
| C2 — tirs cadrés (gratuit) | 2 271 | +0,00290 | −0,00056 | −0,00069 | 3,47 |

### 6b · Comparaison stricte à effectif égal — les 943 mêmes rencontres

Les contrôles gratuits portent sur un historique plus long (2 271 rencontres). Pour comparer honnêtement, il faut les ramener sur **exactement les 943 rencontres** où le xG est actif.

| Modèle | Brier 1X2 | Δ 1X2 | O/U 2,5 | Δ O/U | BTTS | Δ BTTS |
| --- | --- | --- | --- | --- | --- | --- |
| A — sans xG | 0,6009 | — | 0,2461 | — | 0,2480 | — |
| C1 — tirs (gratuit) | 0,6028 | +0,0019 | 0,2454 | −0,0007 | 0,2477 | −0,0003 |
| C2 — tirs cadrés (gratuit) | 0,6028 | +0,0019 | 0,2454 | −0,0007 | 0,2476 | −0,0004 |
| B1 — xG (moteur actuel) | 0,6027 | +0,0018 | 0,2450 | −0,0010 | 0,2470 | −0,0011 |
| **B6 — xG + récence 3** | 0,6021 | +0,0012 | **0,2446** | **−0,0015** | **0,2464** | **−0,0016** |
| **B8 — xG + récence + dom/ext** | **0,6017** | **+0,0008** | 0,2449 | −0,0012 | 0,2471 | −0,0009 |

**Enseignements :**
1. **Les fenêtres courtes aggravent tout.** La fenêtre 5 matchs détériore le 1X2 de +0,00340 avec un intervalle qui **exclut le zéro** : c'est le seul réglage franchement nuisible.
2. **La pondération par récence est le meilleur levier.** B6 (demi-vie 3 matchs) divise par 1,5 la détérioration du 1X2 tout en offrant les meilleurs gains sur Over/Under et BTTS.
3. **Trouvaille inattendue — le xG n'est PAS meilleur que les statistiques gratuites pour le 1X2.** À effectif égal (§6b), les tirs et les tirs cadrés détériorent le 1X2 de **+0,0019**, contre **+0,0018** pour le xG : les trois se valent, aux arrondis près. **La supériorité du xG se situe exclusivement sur les marchés de buts** : sur l'Over/Under 2,5, le xG associé à la récence gagne −0,0015 contre −0,0007 pour les tirs — **le double** ; sur le BTTS, −0,0016 contre −0,0004 — **le quadruple**. Le xG apporte donc bien une information absente des données gratuites, mais cette information ne concerne pas l'issue du match.
4. **La calibration se dégrade dans tous les cas** (2,42 → 3,12 à 5,30). Les probabilités deviennent moins honnêtes, y compris quand le Brier s'améliore.

---

# 7 · ROBUSTESSE (§13)

Le signe du résultat est **identique dans les quatre découpes** pour les trois marchés principaux.

| Découpe | n | 1X2 Δ | O/U 2,5 Δ | BTTS Δ |
| --- | --- | --- | --- | --- |
| Premier League | 622 | +0,00081 | −0,00117 | −0,00056 |
| LaLiga | 321 | +0,00369 | −0,00075 | −0,00209 |
| 1re moitié de saison | — | +0,00199 | — | — |
| 2de moitié de saison | — | +0,00162 | — | — |
| Saison 2024/2025 | 399 | +0,00152 | −0,00066 | −0,00023 |
| Saison 2025/2026 | 544 | +0,00199 | −0,00130 | −0,00171 |

**L'amélioration ne vient donc ni d'un seul championnat, ni d'une seule période, ni d'un seul marché.**

**Limite assumée :** huit variantes ont été testées sur le même jeu de données. La meilleure d'entre elles peut gagner par hasard. C'est pourquoi la décision ne repose pas sur « la meilleure variante » mais sur le **signe constant** de l'effet à travers variantes, championnats, périodes et marchés.

---

# 8 · PAR COMPÉTITION

| Compétition | Rencontres de test | xG actif | Brier 1X2 (A → B) | Over/Under 2,5 | BTTS |
| --- | --- | --- | --- | --- | --- |
| **Premier League** | 1 140 | 622 | 0,6074 → 0,6082 (+0,00081) | −0,00117 | −0,00056 |
| **LaLiga** | 1 140 | 321 | 0,5882 → 0,5919 (+0,00369) | −0,00075 | −0,00209 |
| **Afrique** | **non testée** | — | — | — | — |
| **Togo** | **non testé** | — | — | — | — |

**Afrique et Togo : aucune mesure, et c'est un choix.** Aucune source de comparaison n'existe sur ces compétitions, le score à la mi-temps y est absent (Togo 0 %, Ghana 0,7 %), et la présence du xG n'y a pas été vérifiée. **Aucun chiffre ne sera avancé pour ces compétitions.** Le sujet a été reporté sur votre instruction.

---

# 9 · SCORE EXACT (§14) ET DISTRIBUTION (§15)

**Sur les 2 280 rencontres de test :**

| Indicateur | Modèle A | + xG | + xG avec récence 3 |
| --- | --- | --- | --- |
| Log Loss | 2,9122 | **2,9105** | **2,9098** |
| Probabilité moyenne donnée au score réel | 7,01 % | 7,01 % | 7,01 % |
| Top 1 | 14,08 % | 14,39 % | 14,34 % |
| Top 3 | 33,42 % | 33,60 % | 33,55 % |
| Top 5 | 49,69 % | 49,82 % | **50,00 %** |
| Somme de la distribution | 1,000000 ✔ | 1,000000 ✔ | 1,000000 ✔ |

**Sur les 943 rencontres où le xG agit :** Log Loss 2,9076 → **2,9036** · P(score réel) 6,76 % → **6,76 %** (inchangée, au centième près).

**Aucun « taux de précision » n'est annoncé.** Annoncer une précision sur ce marché serait trompeur : le score exact reste intrinsèquement incertain, et le gain du xG y est de 0,004 de Log Loss — réel mais négligeable à l'échelle du marché.

**Cohérence (§16) :** tous les marchés publiés proviennent de la **même matrice de scores** ; la somme de la distribution vaut exactement 1. Le 1X2 publié provient du consensus des modèles (mécanisme du moteur, inchangé) — c'est précisément ce qui explique que le xG puisse améliorer les marchés de buts tout en dégradant le 1X2.

---

# 10 · ANALYSE DES ERREURS (§19)

Aucune cause n'est avancée sans preuve. Ce qui **est** démontrable à partir des données :

| Observation | Preuve |
| --- | --- |
| La détérioration du 1X2 est **deux fois plus forte en LaLiga** qu'en Premier League | +0,00369 contre +0,00081 |
| L'historique xG de LaLiga est **deux fois plus court** que celui de la Premier League | 80 rencontres enrichies contre 380 |
| Le moteur traite **1 337 rencontres de test** où le xG est inapplicable, sans dégradation | Modèle B ≡ Modèle A sur ces rencontres (2 280 − 943) |
| Les saisons récentes sont **plus difficiles pour tous les modèles** | Brier 1X2 : 0,5793 (2023/24) → 0,6124 (2025/26) |
| Le marché reste **meilleur que les deux modèles** | 0,5676 contre 0,6009 (A) et 0,6027 (B) |

**Ce qui n'est pas avancé :** aucune cause n'est attribuée aux matchs mal prédits (favori qui perd, match prolifique, équipe récemment changée). Les catégories demandées ne sont pas démontrables avec les données actuelles : les identifier exigerait des annotations absentes du dataset.

---

# 11 · DÉCISION TECHNIQUE (§24)

| Question | Réponse mesurée |
| --- | --- |
| **Où le xG améliore-t-il ?** | Tous les marchés de buts : Over/Under 1,5-4,5 (max sur 3,5 : −0,00162), BTTS (−0,00108), buts par équipe (−0,0001 à −0,0008), score exact (−0,004 de Log Loss) |
| **Où n'améliore-t-il rien ?** | Total > 0,5, 1re mi-temps ≥ 1 but (variations inférieures à 0,0002 — indiscernables du bruit) |
| **Où détériore-t-il ?** | **Le 1X2**, de +0,00096 (meilleure variante) à +0,00340 (fenêtre 5), avec 95 % de probabilité de détérioration pour le réglage actuel |
| **Avec combien de matchs ?** | 943 rencontres où le signal agit · 2 280 au total · 622 Premier League · 321 LaLiga · 399 en 2024/2025 · 544 en 2025/2026 |
| **Avec quelle robustesse ?** | Signe identique dans les 2 championnats, les 2 moitiés de saison, les 2 saisons et 9 variantes sur 9 |

### Recommandation

1. **Ne pas utiliser le xG comme signal global.** Le laisser peser 20 % dans le consensus — le réglage actuel — **dégrade le 1X2**.
2. **Utiliser le xG sur les marchés de buts**, où le gain est petit mais systématique : Over/Under, BTTS, buts par équipe, distribution des scores.
3. **Retenir la pondération par récence (demi-vie 3 matchs)** : elle réduit la détérioration du 1X2 d'un tiers (+0,00179 → +0,00121) et augmente le gain sur le BTTS de moitié (−0,00108 → −0,00163).
4. **Ne pas retenir les fenêtres courtes (5 matchs)** : seule configuration dont la détérioration est significative.
5. **Point de tension à trancher** : séparer le 1X2 des marchés de buts suppose que le 1X2 ne provienne plus de la même distribution que le reste. C'est en contradiction partielle avec la règle de cohérence (§16) — le moteur publie déjà le 1X2 depuis le consensus et non depuis la matrice. **Cette décision relève de la phase suivante, pas de celle-ci.**

---

# 12 · COMPARAISON DES STATISTIQUES AVANCÉES — 460 RENCONTRES, 0 CRÉDIT

Les 460 fiches détaillées déjà payées pendant l'enrichissement xG sont en cache. Elles ont donc été confrontées aux fichiers bruts gratuits pour la même saison, **sans dépenser un seul crédit et sans une seule requête réseau**.

**Protocole :** 460 rencontres (380 Premier League + 80 LaLiga, saison 2024/2025) · 6 familles · 2 côtés par rencontre = **5 520 valeurs comparées**. Une valeur n'est comptée que si **les deux** sources la fournissent — une absence n'est jamais comptée comme un accord.

| Famille | Valeurs comparées | Écarts | Taux | Écart moyen | Sens des écarts |
| --- | --- | --- | --- | --- | --- |
| Tirs | 920 | 11 | 1,2 % | 1,09 | 6 fois A plus grand / 5 fois B — **pas de biais** |
| Tirs cadrés | 920 | 4 | 0,4 % | 1,00 | 1 / 3 |
| **Corners** | 920 | 24 | **2,6 %** | 1,00 | **24 / 0 — biais systématique** |
| Fautes | 920 | 6 | 0,7 % | 5,50 | 1 / 5, dont un cas isolé à 10 fautes d'écart |
| **Cartons jaunes** | 920 | 45 | **4,9 %** | 1,04 | **5 / 40 — biais systématique** |
| Cartons rouges | 920 | **0** | **0,0 %** | — | — |
| **Total** | **5 520** | **90** | **1,63 %** | | |

**Contrôle de score, la même vérification :** sur ces 460 rencontres, les deux sources annoncent **exactement le même score, sans une seule discordance**.

### Ce que ce résultat démontre

1. **Les deux sources concordent parfaitement sur le résultat** et **divergent sur 1,6 % du détail statistique**. Le score et la statistique ne se comportent pas de la même manière.
2. **Deux familles présentent un biais directionnel, pas un bruit aléatoire.** Sur les corners, quand les deux sources diffèrent, c'est **toujours** la source historique qui en compte davantage (24 cas sur 24). Sur les cartons jaunes, c'est **presque toujours** LiveFootballApi qui en compte davantage (40 cas sur 45). Un écart qui va toujours dans le même sens signale une **différence de règle de comptage**, pas une erreur ponctuelle.
3. **Aucune cause n'est établie pour ces deux biais** et aucune des deux sources ne peut être désignée comme la bonne : il faudrait un troisième arbitre. Le fait est mesuré, l'explication ne l'est pas.
4. **Un cas isolé d'anomalie** : Everton – Bournemouth (31/08/2024), fautes de l'équipe extérieure annoncées à **1** par la source historique et **11** par LiveFootballApi. Un écart de cette taille sur une seule rencontre, sur 460, relève du défaut de saisie, pas du biais de comptage.
5. **26 statistiques existent chez LiveFootballApi sans équivalent dans la source historique** : xG, xG sur coups de pied arrêtés, possession, occasions manquées, tirs hors cadre, tirs contrés, poteaux, passes totales et réussies, précision de passe, centres, duels, duels aériens, tacles, dribbles, dégagements, interceptions, touches dans la surface, hors-jeu, dégagements du gardien, PPDA (2 mesures), second jaune, rouge direct. **32 statistiques reconnues au total, dont 6 seulement sont recoupables.** Les 26 autres ne sont vérifiables par personne d'autre que le fournisseur.

### Conséquence directe sur ce backtest

**Le xG ne peut pas être recoupé.** Aucune source gratuite n'en publie — vérifié sur 132 colonnes. Les 460 valeurs de xG utilisées dans ce backtest reposent donc sur une **source unique, non vérifiée par un tiers**. Le taux d'écart mesuré ici (1,6 % sur les statistiques recoupables) donne un ordre de grandeur de l'incertitude à laquelle il faut s'attendre sur les statistiques non recoupables — **sans permettre de la quantifier précisément**, puisque précisément elles ne sont pas recoupables.

---

# 13 · COÛT ET TRAÇABILITÉ (§20)

| Poste | Appels | Crédits |
| --- | --- | --- |
| Cadrage `/league_fixtures` (E0 + SP1, saison 2024/2025) | 2 | 2 |
| Contrôle de sûreté sur 3 rencontres anciennes | 3 | 3 |
| Enrichissement Premier League 2024/2025 | 380 | 380 |
| Enrichissement LaLiga 2024/2025 (8 journées) | 80 | 80 |
| **Total phase 11** | **465** | **462** |

**465 appels émis, 462 facturés :** les 3 rencontres du contrôle de sûreté ont été réutilisées depuis le cache pendant l'enrichissement, sans être refacturées. Le solde lu dans les réponses du fournisseur est passé de 464 à 2, exactement comme prévu — la capture du quota dans le corps de la réponse fonctionne.

- **Coût réel par rencontre analysée : 1 crédit** (résultat, mi-temps, 32 statistiques, événements).
- **Solde clé 1 : 2 crédits.** Clés 2 à 18 : **jamais utilisées**, 17 clés sur 18 intactes.
- **Échecs : 0.** Couverture xG : **100 %**.
- Les 460 rencontres enrichies sont **en cache et sur disque** (`data/features/`) : toute réexécution du backtest coûte **0 crédit**.

---

# 14 · CE QUI RESTE À FAIRE — ET CE QU'IL NE FAUT PAS FAIRE

**Décision attendue avant toute suite.** Conformément à §25, aucun import massif n'a été lancé et rien n'a été intégré au moteur de production.

Points ouverts :

1. **Trancher la séparation 1X2 / marchés de buts** (§11, point 5) — c'est la décision structurante.
2. **Le xG n'est recoupable par personne** (§12). Aucune source gratuite n'en publie. Si le xG doit devenir une brique durable du moteur, il faudra soit un second fournisseur de xG pour recouper, soit accepter explicitement le risque d'une source unique — et l'écrire noir sur blanc dans l'interface.
3. **Étendre la mesure à LaLiga complète** (380 crédits supplémentaires) pour vérifier si la détérioration du 1X2 s'atténue avec un historique xG plus profond — l'écart LaLiga / Premier League le suggère, sans le prouver.
4. **Vérifier la calibration sur un échantillon plus large**, la détérioration de l'ECE étant le point faible le plus net.
5. **Togo et compétitions africaines** : à traiter séparément, sans référence externe disponible.
6. **Aucun import massif** avant que ces points soient tranchés. **Le solde de la clé 1 est de 2 crédits** : toute suite nécessite votre autorisation explicite d'utiliser une clé supplémentaire.

---

### Artefacts

| Fichier | Contenu |
| --- | --- |
| `data/backtests/2026-09-29T23-21-44-172Z-backtest-phase11/` | Manifeste, métriques, robustesse, rejeu par rencontre |
| `data/features/live-football-api/E0/2024-2025.json` | 380 rencontres avec xG (persistant, versionné) |
| `data/features/live-football-api/SP1/2024-2025.json` | 80 rencontres avec xG |
| `scripts/backtest/__tests__/leakage.test.ts` | 10 tests d'étanchéité, dont tests de mutation |
| `scripts/backtest/__tests__/variants.test.ts` | 8 tests de fidélité au moteur |
| `npm run backtest` · `npm run backtest:plan` · `npm run backtest:enrich` | Exécution · chiffrage · enrichissement |
| `reports/comparaison-stats-*.json` | Les 90 écarts, détail par rencontre et par famille |
| `npm run compare:stats` | Comparaison des statistiques avancées, 0 crédit |

**128 tests automatisés au vert** · `npx tsc --noEmit` : 0 erreur · moteur de production inchangé.
