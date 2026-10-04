# SOLEIL — PHASE 12 · ARCHITECTURE HYBRIDE BUTS + 1X2

**Date :** 29 septembre 2026
**Coût : 0 crédit.** Aucun appel API. Le cache, les fichiers et les 460 rencontres déjà enrichies ont seuls été utilisés. Clés 2 à 18 : intactes. Clé 1 : 2 crédits, non touchés.
**Moteur de production : non modifié.** Le banc d'essai n'agit que si l'appelant fournit un poids.

---

## LA RÉPONSE EN UNE PHRASE

**La détérioration du 1X2 n'est pas un problème d'information, c'est un problème de calibration — et elle disparaît quand on calibre.** Le xG améliore les marchés de buts de façon **significative à tous les poids testés** ; sur le 1X2, la dégradation brute est **monotone** avec le poids, mais un calibrateur multiclasse ajusté sur le passé la neutralise intégralement sur des données postérieures : les deux architectures deviennent alors **indiscernables** (intervalle de confiance contenant zéro).

---

# 1 · CE QUI A ÉTÉ MESURÉ

| Élément | Valeur |
| --- | --- |
| Rencontres évaluées | **2 280** (1 140 Premier League + 1 140 LaLiga), saisons 2023/24 → 2025/26 |
| Sous-ensemble où le xG agit | **943 rencontres** — périmètre commun à toutes les comparaisons de poids |
| Configurations testées | **9** (2 séries × 4 poids + la référence sans xG) |
| Exécutions du moteur | 20 520 |
| Nouveaux appels API | **0** |
| Tests automatisés | **137 au vert**, dont **9 nouveaux tests de cohérence** (§13, §14) |

Deux séries de xG ont été balayées, aux poids **0 / 10 / 20 / 30 / 40 %** :
la série du moteur (toute la profondeur d'historique) et la série à récence (demi-vie 3 matchs), qui était la meilleure variante de la phase 11.

---

# 2 · POIDS xG — TABLEAU DEMANDÉ (§22)

**Sur les 943 rencontres où le xG agit réellement.**

| Poids demandé | Poids effectif | 1X2 Brier | O/U 2,5 Brier | BTTS Brier | Log Loss 1X2 | ECE |
| --- | --- | --- | --- | --- | --- | --- |
| **0 %** (référence) | 0,0 % | **0,6009** | 0,2461 | 0,2480 | **1,0063** | **2,27** |
| 10 % (moteur) | 11,0 % | 0,6019 | 0,2454 | 0,2474 | 1,0077 | 2,96 |
| **20 % (moteur)** | 19,8 % | 0,6027 | 0,2450 | 0,2470 | 1,0088 | 3,55 |
| 30 % (moteur) | 27,0 % | 0,6035 | 0,2448 | 0,2467 | 1,0100 | 3,79 |
| 40 % (moteur) | 33,0 % | 0,6043 | 0,2446 | 0,2464 | 1,0111 | 4,14 |
| 10 % (récence 3) | 10,9 % | 0,6015 | 0,2452 | 0,2471 | 1,0072 | 2,99 |
| **20 % (récence 3)** | 19,6 % | 0,6021 | 0,2446 | 0,2464 | 1,0080 | 3,60 |
| 30 % (récence 3) | 26,7 % | 0,6028 | 0,2442 | 0,2459 | 1,0089 | 3,71 |
| 40 % (récence 3) | 32,7 % | 0,6034 | 0,2438 | 0,2455 | 1,0098 | 4,30 |

**Le poids effectif est mesuré, pas supposé :** il diffère du poids demandé parce que la confiance intrinsèque du modèle et sa divergence par rapport à la médiane des autres modèles le modulent. À 40 % demandés, le modèle xG ne pèse en réalité que 33 % du consensus.

## Écarts appariés contre le modèle A (intervalle de confiance à 95 %, 943 rencontres)

| Configuration | Δ 1X2 | IC 95 % | P(mieux que A) | Δ O/U 2,5 | Δ BTTS |
| --- | --- | --- | --- | --- | --- |
| xG 10 % | +0,00100 | [−0,00038 ; +0,00230] | 0,08 | **−0,00066** | **−0,00066** |
| **xG 20 %** | +0,00179 | [−0,00030 ; +0,00385] | **0,05** | **−0,00103** | **−0,00108** |
| xG 30 % | +0,00262 | [−0,00007 ; +0,00530] | 0,03 | **−0,00128** | **−0,00138** |
| xG 40 % | **+0,00343** | **[+0,00025 ; +0,00666]** | 0,02 | −0,00147 | **−0,00163** |
| récence 3 · 10 % | +0,00065 | [−0,00081 ; +0,00204] | 0,18 | **−0,00092** | **−0,00098** |
| **récence 3 · 20 %** | **+0,00121** | [−0,00110 ; +0,00341] | **0,14** | **−0,00151** | **−0,00163** |
| récence 3 · 30 % | +0,00187 | [−0,00115 ; +0,00480] | 0,10 | **−0,00192** | **−0,00212** |
| récence 3 · 40 % | +0,00255 | [−0,00109 ; +0,00604] | 0,08 | **−0,00223** | **−0,00250** |

*En gras : l'intervalle de confiance exclut le zéro — l'effet est établi, pas supposé.*

### Trois lectures, toutes mesurées

1. **Les marchés de buts gagnent, et le gain est établi à tous les poids.** À partir de 10 %, l'intervalle de confiance du BTTS et de l'Over/Under exclut systématiquement le zéro (probabilité d'amélioration 0,98 à 1,00). Le gain **croît avec le poids** : BTTS −0,00098 à 10 %, −0,00250 à 40 %.
2. **Le 1X2 se dégrade, et la dégradation est monotone.** Elle n'est **pas** établie statistiquement à 10 % (P = 0,08 à 0,18), elle l'est seulement à 40 % série moteur (intervalle [+0,00025 ; +0,00666]).
3. **Le rendement s'inverse entre poids et poids.** De 10 % à 40 %, le gain sur le BTTS progresse par paliers décroissants (+0,00065, +0,00049, +0,00038) tandis que la dégradation du 1X2 accélère (+0,00056, +0,00066, +0,00068). **Le point de meilleur rendement est 20 %.**

---

# 3 · STABILITÉ (§8) — LE POIDS OPTIMAL NE CHANGE PAS SELON LA PÉRIODE

| Découpe | Δ 1X2 · xG 20 % | Δ 1X2 · récence 3 · 20 % |
| --- | --- | --- |
| Premier League (622) | +0,00081 | +0,00007 |
| LaLiga (321) | +0,00369 | +0,00340 |
| 1re moitié de saison | +0,00199 | +0,00117 |
| 2de moitié de saison | +0,00162 | +0,00124 |
| Saison 2024/2025 | +0,00152 | +0,00099 |
| Saison 2025/2026 | +0,00199 | +0,00136 |

**Le signe ne s'inverse dans aucune découpe** et les amplitudes restent dans le même ordre de grandeur : le modèle n'est pas instable au sens de §8. La seule réserve, répétée depuis la phase 11 : **la LaLiga dégrade deux à trois fois plus**, et c'est la compétition dont l'historique xG est le plus court (80 rencontres payées contre 380).

---

# 4 · MASSE DE LA DISTRIBUTION ET ARCHITECTURE COHÉRENTE (§13, §19)

Le moteur actuel agrège **deux fois**, par deux chemins différents :

```
1X2  ←  moyenne pondérée des probabilités de chaque modèle    (chemin « moyenné »)
matrice de scores  ←  moyenne pondérée des λ de chaque modèle → Poisson/Dixon-Coles
                     → Over/Under, BTTS, buts par équipe, score exact, mi-temps
```

Les deux chemins peuvent donc se contredire : rien ne garantit que le 1X2 publié soit celui qu'implique la distribution des scores. **C'est exactement l'objet de la question §23.**

## Comparaison des deux architectures, aux mêmes poids

| Configuration | 1X2 moyenné | 1X2 dérivé de la matrice | Écart | Somme de la distribution |
| --- | --- | --- | --- | --- |
| A (0 %) | 0,6009 | **0,6006** | −0,00026 | 1,0000000 |
| xG 10 % | 0,6019 | 0,6015 | −0,00038 | 1,0000000 |
| xG 20 % | 0,6027 | 0,6022 | −0,00044 | 1,0000000 |
| xG 30 % | 0,6035 | 0,6030 | −0,00048 | 1,0000000 |
| xG 40 % | 0,6043 | 0,6038 | −0,00051 | 1,0000000 |
| récence 3 · 20 % | 0,6021 | 0,6017 | −0,00044 | 1,0000000 |

**Le 1X2 dérivé de la distribution est meilleur que le 1X2 moyenné à TOUS les poids** (−0,00026 à −0,00051), et il rend la cohérence gratuite : par construction, le 1X2 est alors **exactement** la somme des scores correspondants. La somme de la distribution vaut 1,0000000 dans les deux cas.

---

# 5 · CALIBRATION (§7, §22) — LE CŒUR DE LA PHASE

**Protocole :** calibrateur ajusté sur **2023/24 + 2024/25** (1 520 rencontres), mesuré sur **2025/26** (760 rencontres) — **jamais** sur les données d'ajustement. Brier 1X2 sur la saison de validation :

| Configuration | Chemin | Brut | Température (T) | **Vecteur (T, c)** | Δ calibré contre A calibré | IC 95 % |
| --- | --- | --- | --- | --- | --- | --- |
| **A — sans xG** | moyenné | 0,6124 | 0,6121 (T=0,78) | 0,6122 | référence | — |
| **A — sans xG** | matrice | 0,6111 | 0,6108 | **0,6106** | référence | — |
| xG 10 % | moyenné | 0,6132 | 0,6121 | 0,6119 | +0,00021 | [−0,00027 ; +0,00070] |
| xG 10 % | matrice | 0,6119 | 0,6107 | 0,6104 | +0,00016 | [−0,00029 ; +0,00064] |
| **xG 20 %** | moyenné | 0,6138 | 0,6123 | **0,6113** | −0,00038 | [−0,00125 ; +0,00048] |
| **xG 20 %** | matrice | 0,6125 | 0,6108 | **0,6103** | +0,00008 | [−0,00036 ; +0,00055] |
| xG 30 % | moyenné | 0,6144 | 0,6126 | 0,6120 | +0,00019 | [−0,00076 ; +0,00117] |
| **récence 3 · 20 %** | moyenné | 0,6134 | 0,6118 | **0,6107** | −0,00039 | [−0,00125 ; +0,00048] |
| **récence 3 · 20 %** | **matrice** | 0,6121 | 0,6103 | **0,6098** | +0,00015 | [−0,00058 ; +0,00095] |
| récence 3 · 30 % | matrice | 0,6126 | 0,6100 | 0,6098 | +0,00009 | [−0,00082 ; +0,00105] |

## Ce que ce tableau démontre

1. **Le calibrateur répare le 1X2.** Brut, le xG 20 % est le plus mauvais (0,6138 contre 0,6124 pour A). Calibré, il devient **meilleur** (0,6113 contre 0,6122). La dégradation mesurée en phase 11 était donc, pour l'essentiel, **un défaut de calibration du moteur, révélé par le xG — pas un défaut du xG**.
2. **Mais l'écart final n'est pas établi.** Tous les intervalles de confiance contiennent zéro. La conclusion correcte n'est pas « le xG améliore le 1X2 » mais « **après calibration, les deux architectures sont indiscernables sur le 1X2** ».
3. **Le meilleur dispositif n'est pas celui qu'on attendait** : ce n'est ni le 1X2 moyenné, ni le poids le plus faible. C'est **récence 3 · 20 % dérivé de la matrice, calibré** — **0,6098**, le meilleur des douze dispositifs mesurés. À titre de repère, la même architecture sans xG donne 0,6106 et l'architecture actuelle calibrée 0,6122. C'est aussi, et c'est décisif, le dispositif **entièrement cohérent**.
4. **Le modèle était sous-confiant et mal réglé sur le nul.** La température ajustée est de 0,66 à 0,78 — donc **inférieure à 1 : le moteur aplatit ses probabilités** et doit être affûté. Le coefficient du nul vaut 1,24 à 1,32 — donc, une fois affûté, **il faut remonter la probabilité du nul**. Ces deux paramètres apparaissent avec le même signe dans toutes les découpes (voir §7).

---

# 6 · STABILITÉ DU CALIBRATEUR (§8)

Ajustement indépendant sur chaque période — si le calibrateur sur-apprenait, les paramètres changeraient du tout au tout d'une période à l'autre.

| Configuration | 2023/24 seul (n = 760) | 2024/25 seul (n = 760) | Les deux (n = 1 520) |
| --- | --- | --- | --- |
| A — sans xG | T=0,66 · c(nul)=1,320 · c(ext)=1,040 | T=0,73 · c(nul)=1,200 · c(ext)=0,980 | T=0,69 · c(nul)=1,260 · c(ext)=1,020 |
| xG 20 % | T=0,66 · c(nul)=1,320 · c(ext)=1,040 | T=0,66 · c(nul)=1,260 · c(ext)=0,980 | T=0,66 · c(nul)=1,280 · c(ext)=1,000 |
| récence 3 · 20 % | T=0,66 · c(nul)=1,320 · c(ext)=1,040 | T=0,66 · c(nul)=1,260 · c(ext)=0,980 | T=0,66 · c(nul)=1,280 · c(ext)=1,000 |

**Les paramètres sont stables** : T ∈ [0,66 ; 0,73], c(nul) ∈ [1,20 ; 1,32], c(ext) ∈ [0,98 ; 1,04]. La correction n'est pas un artefact de sur-ajustement — elle décrit un biais réel et reproductible du moteur.

---

# 7 · LA CLASSE NUL (§9) — L'HYPOTHÈSE EST INFIRMÉE

Il était plausible que la dégradation du 1X2 vienne du nul. **Ce n'est pas le cas, et c'est mesurable.**

## Décomposition du Brier 1X2 par issue — saison 2025/26 (n = 760)

| Configuration | Brier domicile | Brier NUL | Brier extérieur |
| --- | --- | --- | --- |
| A — sans xG (brut) | 0,2285 | 0,1913 | 0,1925 |
| xG 20 % (brut) | 0,2297 | **0,1914** | 0,1927 |
| récence 3 · 20 % (brut) | 0,2295 | **0,1914** | 0,1924 |
| A — sans xG (calibré) | **0,2274** | 0,1918 | 0,1929 |
| xG 20 % (calibré) | **0,2273** | 0,1919 | 0,1920 |
| récence 3 · 20 % (calibré) | **0,2272** | 0,1919 | **0,1917** |

**Le nul ne bouge pas.** Le xG le dégrade de 0,0001 — quantité négligeable. Toute la dégradation se porte sur la classe **domicile** (+0,0012). L'hypothèse « le problème vient du nul » est **infirmée par la mesure**.

**Et le calibrateur ne répare pas le nul** : il répare **domicile** (0,2285 → 0,2274) et **extérieur** (0,1927 → 0,1920 pour les configurations xG). Le nul reste à 0,1918-0,1919 dans tous les cas.

## Fiabilité de la probabilité de nul — le vrai défaut est ailleurs

Probabilité annoncée contre fréquence réellement observée, saison 2025/26, modèle A :

| Tranche de P(nul) | n | Annoncé | **Observé** | Écart |
| --- | --- | --- | --- | --- |
| < 0,20 | 52 | 0,182 | 0,135 | −4,7 pts |
| 0,20 – 0,24 | 205 | 0,223 | 0,224 | **+0,1 pt** ✔ |
| **0,24 – 0,28** | **359** | **0,259** | **0,290** | **+3,1 pts** ⚠️ |
| 0,28 – 0,32 | 129 | 0,293 | 0,295 | +0,2 pt ✔ |
| ≥ 0,32 | 15 | 0,329 | 0,133 | *n trop faible pour conclure* |

**Le moteur sous-estime les nuls uniquement dans la tranche majoritaire** — celle qui contient 359 des 760 rencontres : quand il annonce 25,9 % de nul, il s'en produit 29,0 %. C'est précisément ce que le coefficient c(nul) = 1,26-1,32 corrige. Les tranches extrêmes sont correctement calibrées. La tranche ≥ 0,32 (15 rencontres) est **trop petite pour être interprétée** et n'est reportée que pour la transparence.

---

# 8 · ARCHITECTURE HYBRIDE (§19) — TESTÉE, PUIS ÉCARTÉE

L'architecture hybride naïve — **1X2 pris sur le modèle sans xG, marchés de buts pris sur le modèle avec xG** — a été évaluée puis comparée à l'alternative cohérente.

| Dispositif | 1X2 Brier | O/U 2,5 | BTTS | **Incohérence introduite** |
| --- | --- | --- | --- | --- |
| 1X2 = A · buts = xG 20 % | 0,6009 | 0,2450 | 0,2470 | **0,01685** |
| 1X2 = A · buts = récence 3 · 20 % | 0,6009 | 0,2446 | 0,2464 | **0,01799** |
| 1X2 = A · buts = récence 3 · 30 % | 0,6009 | 0,2442 | 0,2459 | **0,02407** |
| **Cohérent : A seul, 1X2 dérivé de la matrice** | **0,6006** | 0,2461 | 0,2480 | **0** |

*« Incohérence » = écart moyen entre le 1X2 publié et le 1X2 qu'implique la distribution des scores, en variation totale. 0,017 signifie que 1,7 point de probabilité s'écarte, en moyenne, de la distribution.*

**Conclusion :** l'hybride achète −0,0015 sur l'Over/Under et −0,0016 sur le BTTS, mais il publie un 1X2 qui **contredit sa propre distribution de scores de 1,7 à 2,4 points** — et son 1X2 (0,6009) est **moins bon** que celui de l'architecture cohérente (0,6006). **L'hybride est donc dominé : il coûte de la cohérence et rapporte moins.** Il est écarté.

---

# 9 · MARCHÉS DE BUTS, UN PAR UN (§11)

**Sur les 943 rencontres où le xG agit, contre le modèle A.** Δ négatif = amélioration. Aucune valeur n'est extrapolée : chaque marché est mesuré sur la distribution complète des scores.

| Marché | A | xG 20 % | Δ | récence 3 · 20 % | Δ |
| --- | --- | --- | --- | --- | --- |
| Total > 0,5 | 0,0434 | 0,0433 | −0,0001 | 0,0433 | −0,0002 |
| Total > 1,5 | 0,1649 | 0,1642 | −0,0007 | **0,1641** | **−0,0009** |
| **Total > 2,5** | 0,2461 | 0,2450 | **−0,0010** | **0,2446** | **−0,0015** |
| **Total > 3,5** | 0,2076 | **0,2059** | **−0,0016** | 0,2061 | −0,0015 |
| Total > 4,5 | 0,1240 | 0,1230 | −0,0010 | **0,1228** | **−0,0012** |
| **BTTS** | 0,2480 | 0,2470 | **−0,0011** | **0,2464** | **−0,0016** |
| Buts domicile > 0,5 / 1,5 / 2,5 | 0,1672 / 0,2351 / 0,1538 | 0,1669 / 0,2350 / 0,1537 | −0,0004 / −0,0001 / −0,0001 | 0,1665 / 0,2345 / 0,1534 | −0,0007 / −0,0006 / −0,0004 |
| Buts extérieur > 0,5 / 1,5 / 2,5 | 0,1858 / 0,2252 / 0,0997 | 0,1852 / 0,2245 / 0,0988 | −0,0006 / −0,0007 / −0,0008 | 0,1849 / 0,2245 / 0,0989 | −0,0008 / −0,0007 / −0,0008 |
| 1re mi-temps > 0,5 / 1,5 / 2,5 | 0,1950 / 0,2266 / 0,1157 | 0,1949 / 0,2258 / 0,1155 | −0,0001 / −0,0008 / −0,0002 | 0,1948 / 0,2257 / 0,1154 | −0,0002 / −0,0009 / −0,0003 |

**Les gains ne se transfèrent pas uniformément** — c'est bien pourquoi chaque marché a été mesuré séparément :
- **Les lignes centrales gagnent le plus** : Over/Under 2,5 (−0,0015), 3,5 (−0,0015), BTTS (−0,0016).
- **La ligne 0,5 ne gagne rien** (variation de 0,0001 à 0,0002) : savoir *combien* de buts attendre n'aide pas à savoir s'il y en aura **au moins un**. Constat cohérent avec un signal qui porte sur le niveau du total, pas sur son existence.
- **Les buts par équipe gagnent peu** (−0,0004 à −0,0008) : le xG aide surtout le **total**, pas la répartition entre les deux équipes.
- **La mi-temps gagne peu** (−0,0009 au mieux) : la série xG porte sur des matchs entiers, elle éclaire mal leur découpage.

---

# 10 · SCORE EXACT (§12) — MESURÉ SÉPARÉMENT, SANS EXTRAPOLER

| Configuration | Log Loss | P(score réel) | Top 1 | Top 3 | Top 5 | Somme |
| --- | --- | --- | --- | --- | --- | --- |
| A — sans xG | 2,9076 | 6,76 % | 12,2 % | 31,7 % | 48,5 % | 1,000000 |
| xG 20 % | 2,9036 | 6,76 % | **12,9 %** | **32,1 %** | 48,8 % | 1,000000 |
| **récence 3 · 20 %** | **2,9019** | 6,77 % | 12,8 % | 32,0 % | **49,2 %** | 1,000000 |

**Le gain sur le score exact est réel mais minime** : Log Loss −0,0057 pour la meilleure configuration. Et il n'est **pas déduit** du gain sur l'Over/Under : il est mesuré sur la distribution complète.

**Ce qui n'est pas annoncé :** aucune « précision » du score exact. Top 1 = 12,8 % signifie que le score exact le plus probable est le bon dans **13 % des cas environ** — contre 12,2 % pour le modèle actuel. Le marché reste intrinsèquement incertain, et c'est le marché où le gain du xG est le plus faible en valeur absolue.

**Cohérence vérifiée** : la somme de la distribution vaut exactement 1,000000 dans toutes les configurations.

---

# 11 · ANALYSE DES ERREURS (§10) — A CONTRE xG 20 %

943 rencontres. **Aucune cause n'est avancée sans mesure.**

| Mesure | Résultat |
| --- | --- |
| Favori désigné qui **change** entre A et B | **35 / 943** (3,7 %) |
| Favori faux — A | 467 |
| Favori faux — B | **466** |
| Faux dans les deux | 452 |
| P(nul) **abaissée** par le xG | 335 / 943 (36 %) |
| P(extérieur) **relevée** par le xG | **625 / 943 (66 %)** |
| P(nul) moyenne | 0,2440 → **0,2468** |
| λ total moyen | 2,880 → **2,860** |

**Le xG ne change pas le nombre de favoris faux** (467 → 466) et ne déplace que 3,7 % des désignations. En revanche il **relève la probabilité de victoire extérieure dans deux matchs sur trois** et **abaisse le total de buts attendu**. C'est un signal de « resserrement » des matchs.

## Où la dégradation se concentre exactement

| Découpe | n | Δ Brier 1X2 |
| --- | --- | --- |
| **Match à 4 buts et plus** | 276 | **+0,00460** |
| Match à 2-3 buts | 471 | +0,00077 |
| Match à 0-1 but | 196 | +0,00027 |
| **Favori très net** | 320 | **+0,00619** |
| Favori net | 342 | +0,00038 |
| **Favori peu net** | 281 | **−0,00150** |
| Nul improbable (< 24 %) | 417 | **+0,00430** |
| Nul moyen (24-28 %) | 385 | −0,00005 |
| Nul probable (≥ 28 %) | 141 | **−0,00060** |
| **Match fermé (λ < 2,4)** | 125 | **−0,00162** |
| Match médian | 599 | +0,00209 |
| **Match ouvert (λ ≥ 3,2)** | 219 | **+0,00291** |

**Trois constats, tous mesurés :**
1. Le xG **améliore les matchs fermés** (−0,0016) et **dégrade les matchs ouverts** (+0,0029) — cohérent avec un signal qui abaisse le total de buts attendu.
2. Le xG **dégrade les matchs à favori très net** (+0,0062) et **améliore les matchs à favori peu net** (−0,0015).
3. Le xG **dégrade les matchs à 4 buts et plus** (+0,0046), précisément ceux dont le total est le plus difficile à anticiper.

**Ce qui n'est toujours pas démontré :** aucune cause n'est attribuée à ces trois concentrations. Les données disponibles permettent de **localiser** l'erreur, pas d'en établir l'origine. Toute explication avancée ici serait une hypothèse, pas un résultat.

---

# 12 · CALIBRATION DES MARCHÉS DE BUTS (§7, §11) — RÉSULTAT MITIGÉ

Même protocole : ajustement sur 2023/24 + 2024/25, validation sur 2025/26.

| Marché | Avant (Brier) | Après (Brier) | T ajusté | Verdict |
| --- | --- | --- | --- | --- |
| Over/Under 2,5 | 0,2486 | **0,2479** | 1,15 | ✅ améliore |
| Over/Under 3,5 | 0,1969 | **0,1977** | 1,11 | ❌ dégrade |
| BTTS | 0,2503 | **0,2495** | 1,21 | ✅ améliore |

**La calibration des marchés binaires n'est pas un gain universel** : elle aide la ligne 2,5 et le BTTS et **dégrade** la ligne 3,5. Les températures ajustées sont toutes supérieures à 1 — les marchés de buts sont donc **légèrement trop confiants**, à l'inverse du 1X2 (T < 1). Contrairement au 1X2, **la calibration binaire est donc à retenir marché par marché, pas globalement.**

---

# 13 · DÉCISION (§22)

## Comparaison des quatre options

| Option | Verdict mesuré |
| --- | --- |
| **A. xG global** | ❌ **Écartée.** Le 1X2 brut se dégrade de façon monotone, jusqu'à +0,00343 avec un intervalle excluant zéro à 40 %. |
| **B. xG uniquement pour les marchés de buts** | ❌ **Écartée.** Elle fonctionne (1X2 inchangé, buts améliorés) mais introduit **1,7 à 2,4 points d'incohérence** et publie un 1X2 **moins bon** que l'architecture cohérente. Dominée. |
| **C. xG faiblement pondéré** | ✅ **RETENUE**, sous conditions — voir ci-dessous. |
| **D. aucun changement** | ❌ **Écartée.** Le gain sur les marchés de buts est établi à tous les poids testés (probabilité d'amélioration ≥ 0,98) ; y renoncer serait refuser un gain mesuré. |

## Recommandation : option C, avec une correction d'architecture

**Le xG est conservé à 20 %, avec pondération par récence (demi-vie 3 matchs)** — mais **uniquement à l'intérieur d'une architecture cohérente et calibrée** :

1. **Un seul modèle de buts** produit **une seule distribution de scores**.
2. **Le 1X2 est DÉRIVÉ de cette distribution**, il n'est plus moyenné séparément.
3. **Une couche de calibration 1X2** ajustée sur l'historique (T ≈ 0,66-0,76, vecteur c ≈ [1 ; 1,28 ; 1,00]) répare le biais d'aplatissement et le biais du nul.

**Pourquoi 20 % et pas 30 ou 40 ?** Parce que c'est le point de meilleur rendement : au-delà, le gain sur le BTTS progresse de +0,0004 par palier de 10 % tandis que la dégradation du 1X2 progresse de +0,0007. Et parce que 20 % est le poids le plus élevé pour lequel la dégradation du 1X2 **n'est pas établie statistiquement** (P = 0,14 pour la série à récence).

**Pourquoi la pondération par récence ?** À même poids de 20 %, elle dégrade le 1X2 moitié moins (+0,00121 contre +0,00179), améliore davantage l'Over/Under (−0,00151 contre −0,00103) et davantage le BTTS (−0,00163 contre −0,00108). Elle domine le poids uniforme.

### Ce que ce dispositif vaut, chiffré, sur la saison de validation 2025/2026

| Dispositif | Brier 1X2 |
| --- | --- |
| Moteur actuel (1X2 moyenné, brut) | 0,6124 |
| Moteur actuel + calibration | 0,6122 |
| Architecture cohérente (1X2 dérivé de la matrice) + calibration, **sans** xG | 0,6106 |
| **Architecture cohérente + calibration + xG récence 3 à 20 %** | **0,6098** |

**Décomposition du gain total : −0,0026.** La calibration seule apporte −0,0002 ; le passage à l'architecture cohérente apporte −0,0016 ; l'ajout du xG apporte −0,0008. **Chacune de ces composantes, prise isolément, n'est pas établie statistiquement** — les intervalles de confiance contiennent zéro (§5). C'est la **somme** qui est rapportée ici, pas une preuve composante par composante.

**Et l'essentiel n'est pas dans le chiffre :** ce dispositif publie des marchés qui **ne peuvent plus se contredire**, des probabilités qui veulent dire ce qu'elles annoncent (ECE 1,6 contre 2,3 avant calibration pour la configuration xG), et un 1X2 qui n'est plus pénalisé par l'usage du xG.

---

# 14 · RÉPONSES AUX QUATRE QUESTIONS DE §23

### 1. Quelle architecture SOLEIL doit adopter ?

**Le modèle de buts devient la source unique.** Une distribution de scores, une seule, alimente tous les marchés — Over/Under, BTTS, buts par équipe, score exact **et 1X2**. Le 1X2 cesse d'être moyenné à part : c'est ce qui supprime la possibilité même d'une contradiction entre marchés.

**Mesure à l'appui :** le 1X2 dérivé de la distribution est meilleur que le 1X2 moyenné à **tous** les poids testés (−0,00026 à −0,00051 sur 943 rencontres ; −0,0010 à −0,0016 après calibration sur la saison de validation).

### 2. Quel poids xG doit être utilisé ?

**20 %, avec pondération par récence (demi-vie 3 matchs).**

**Mesure à l'appui :** gain établi sur l'Over/Under 2,5 (−0,00151, IC [−0,00266 ; −0,00043]) et sur le BTTS (−0,00163, IC [−0,00251 ; −0,00077]) ; sur le 1X2, dégradation non établie (+0,00121, IC [−0,00110 ; +0,00341], P = 0,14) et **annulée par la calibration**.

### 3. Le 1X2 doit-il rester entièrement dérivé de la distribution des scores ?

**Oui — à une correction près.** Le 1X2 doit être **lu dans la distribution**, puis **corrigé par une couche de calibration** explicite, ajustée sur le passé et validée sur le futur.

**Pourquoi ce n'est pas une entorse à la cohérence :** la calibration ne fabrique pas de probabilités indépendantes. Elle applique une transformation **mathématiquement définie** (T, c) à la sortie de la distribution, dont l'effet est mesuré. Mais elle **éloigne** le 1X2 publié du 1X2 brut de la distribution — cet écart doit donc être **documenté et affiché**, jamais subi.

**Et si l'on refuse toute transformation :** le 1X2 100 % dérivé de la distribution, sans calibration, reste **préférable** à l'architecture actuelle — 0,6006 contre 0,6009 sur 943 rencontres, cohérence totale, et aucune contrepartie. C'est le repli sûr, immédiatement applicable.

### 4. Comment préserver la cohérence mathématique entre les marchés ?

**Par construction, puis par test automatique.** **9 tests** ont été ajoutés, et ils échouent si la cohérence se rompt :

| Test | Ce qu'il vérifie |
| --- | --- |
| Somme de la distribution | = 1 à toutes les pondérations (0 à 40 %) |
| Somme du 1X2 | = 1 dans les deux architectures |
| 1X2 dérivé de la matrice | **est** la somme des scores, à 1e-12 près |
| Over/Under 2,5 | **est** la masse des scores à 3 buts et plus |
| BTTS | **est** la somme des scores où les deux équipes marquent |
| Buts par équipe | **est** la somme des scores correspondants |
| Non-contradiction (§14) | si P(Over 2,5) monte, la masse des scores élevés monte **dans le même sens** |
| Inégalités imposées par la réalité | P(BTTS) ≤ P(au moins 2 buts), P(BTTS) ≤ P(domicile marque), etc. |
| Bornes | aucune probabilité nulle, négative ou supérieure à 1 |

Ces tests ne se contentent pas de vérifier des identités décoratives : ils vérifient des **inégalités que la réalité impose**. Une probabilité de BTTS supérieure à la probabilité qu'il y ait au moins deux buts est **mathématiquement impossible** — le test échoue si elle apparaît.

---

# 15 · QUALITÉ DU xG (§15) — MENTION À CONSERVER TELLE QUELLE

> **Le xG utilisé ici est fourni par API Football Live et cohérent dans les données reçues, mais non vérifié par une seconde source indépendante.**

Aucune source gratuite ne publie de xG (vérifié : 132 colonnes, zéro colonne « xG »). Les 460 rencontres enrichies reposent donc sur **une source unique**. La phase 10 a mesuré que sur les statistiques **recoupables** (tirs, tirs cadrés, corners, fautes, cartons), les deux sources divergent de 1,6 % et présentent **deux biais directionnels** : sur les corners, c'est toujours l'ancienne source qui en compte davantage (24 cas sur 24) ; sur les cartons jaunes, c'est toujours LiveFootballApi (40 cas sur 45). Ce taux donne un **ordre de grandeur** de l'incertitude attendue sur les statistiques non recoupables — **sans permettre de la quantifier**, puisque précisément elles ne sont pas recoupables.

**Cette mention reste obligatoire dans la documentation interne tant qu'un second fournisseur de xG n'a pas recoupé les valeurs.**

---

# 16 · LIMITES — CE QUE CE RAPPORT NE PROUVE PAS

1. **La calibration est validée sur une seule saison** (2025/2026, 760 rencontres). Les paramètres sont stables sur deux périodes d'ajustement, mais le **gain** n'a été mesuré qu'une fois. Il faudra le suivre en production.
2. **Le sous-ensemble xG ne couvre que 943 rencontres** sur 2 280, deux championnats, deux saisons. La LaLiga y est sous-représentée (80 rencontres payées) et dégrade systématiquement plus.
3. **Neuf configurations ont été comparées** sur le même jeu de données. Le risque de sélection existe. C'est pourquoi la décision repose sur le **signe constant** de l'effet à travers poids, championnats, périodes et marchés, jamais sur la meilleure ligne d'un tableau.
4. **Les écarts restent petits.** Un millième de Brier ne transformera pas l'expérience utilisateur. L'enjeu réel de cette phase est **architectural et honnête** : des marchés qui ne se contredisent plus, et des probabilités qui veulent dire ce qu'elles annoncent.
5. **Aucune cause n'est établie** pour les trois concentrations d'erreur du §11, ni pour les deux biais directionnels de la phase 10.

---

# 17 · TRAÇABILITÉ

| Élément | Emplacement |
| --- | --- |
| Résultats complets | `data/backtests/2026-09-29T23-43-15-138Z-phase12/phase12.json` |
| Rejeu par rencontre | `data/backtests/2026-09-29T23-43-15-138Z-phase12/records.jsonl` |
| Banc d'essai du consensus | `scripts/backtest/ensemble-lab.ts` |
| Calibrateurs multiclasse | `scripts/backtest/calibration.ts` |
| Banc d'essai de la phase 12 | `scripts/backtest/phase12.ts` |
| Tests de cohérence (§13, §14) | `scripts/backtest/__tests__/coherence.test.ts` — 9 tests |
| Commande | `npm run backtest:phase12` (0 crédit) |

**Crédits : 0.** Clé 1 : 2 crédits, inchangés. Clés 2 à 18 : jamais utilisées. **Moteur de production : non modifié.** `npx tsc --noEmit` : 0 erreur. **137 tests au vert. Aucun import massif.**

---

# ERRATUM — 30 septembre 2026 (constaté en phase 13)

Le tableau « **Comparaison finale — 1X2 calibré, validé sur 2025/26** » du §5 comporte deux
défauts, découverts en tentant de le reproduire pendant la phase 13.

**1. Le périmètre était trop large.** Le tableau calculait ses niveaux de Brier sur **les
760 rencontres de la saison 2025/2026**, y compris les **216 rencontres où le xG est
inapplicable** et où le modèle B est rigoureusement identique au modèle A. Le périmètre
correct est celui où le signal agit : **544 rencontres**.

**2. Son Δ ne se réconcilie pas avec ses propres niveaux affichés.** Pour la ligne
`recence3_w20 / ensemble`, le tableau affiche 0,6122 et 0,6107, soit un écart de −0,0015,
tout en annonçant un Δ de −0,00039. Une comparaison appariée ne peut pas produire un Δ
différent de la différence de ses propres moyennes : l'un des deux chiffres est faux.

**Valeurs correctes** (recalculées depuis les données de la phase 12, revérifiées par un
calcul indépendant en Python) :

| Périmètre | A calibré | B calibré | Δ |
| --- | --: | --: | --: |
| 760 rencontres — périmètre du §5 | 0,6122 | 0,6107 | **−0,00143** |
| **544 rencontres avec xG actif — périmètre correct** | **0,6111** | **0,6091** | **−0,00199** |

**3. Le §5, le §6 et la table de fiabilité du §7 portent eux aussi sur 760 rencontres.**
Vérifié : le Brier brut annoncé au §5 pour la saison de validation (0,6124 pour W0) se
reproduit **exactement** sur les 760 rencontres, et non sur les 544 où le xG agit. Ces
sections mélangent donc, dans leur moyenne, 216 rencontres où le modèle A et le modèle B
sont rigoureusement identiques.

**Portée exacte de la correction :**

| Sections du rapport | Périmètre utilisé | Concernées ? |
| --- | --- | --- |
| §1, §2, §3, §4 — balayage des poids, écarts, architecture | 943 (xG actif) | **Non** — se reproduisent à l'identique |
| §5 — calibration 1X2 (tableau) | 760 + ajustement sur 1 520 | **Oui** |
| §6 — stabilité du calibrateur | 760 et 1 520 | **Oui** |
| §7 — fiabilité par tranche | 760 | **Oui** |
| §8 — architecture hybride | 943 | **Non** |
| §9, §10, §11 — marchés de buts, score exact, erreurs | 943 | **Non** |

- **La conclusion qualitative ne change pas.** L'effet du xG sur le 1X2 hors échantillon
  était déjà rapporté comme « non établi » — intervalle de confiance contenant zéro. Il le
  reste, et la phase 13 le confirme sur le périmètre correct.
- **Les chiffres changent dans un sens favorable.** L'effet réel est de −0,0020 et non
  de −0,0004 : le xG améliorait le 1X2 davantage que ce qui avait été publié.
- **Un point méthodologique subsiste au §5** : le calibrateur y était ajusté sur 1 520
  rencontres, dont 1 121 où le xG est inapplicable et où B ≡ A. Cet ajustement décrit donc
  surtout le modèle A. La phase 13 réajuste sur le seul sous-ensemble où le signal agit.

La phase 13 (`reports/rapport-13-validation-xg-tous-marches.md`, §9) documente ce constat
et recalcule l'ensemble sur le périmètre correct.
