# SOLEIL — PHASE 13 · VALIDATION EXHAUSTIVE DU xG CALIBRÉ, MARCHÉ PAR MARCHÉ

**Date :** 30 septembre 2026
**Coût : 0 crédit.** Aucun appel API. Clé 1 : 2 crédits, intacts. Clés 2 à 18 : jamais touchées.
**Moteur de production : non modifié.** Toute cette phase est expérimentale.
**Commande :** `npm run backtest:phase13`

---

# RÉSUMÉ EXÉCUTIF

**Le xG à 20 % avec pondération par récence améliore 35 des 41 marchés testés.** Sur les marchés de buts — Over/Under, BTTS, score exact — le gain est cohérent, de signe constant dans les six découpes temporelles, et **21 améliorations sont statistiquement établies**.

**Mais le résultat le plus important de cette phase est un résultat négatif, et il faut le dire clairement :**

> **Sur le 1X2, l'amélioration n'est PAS établie hors échantillon.** Le xG brut dégrade légèrement le 1X2 (+0,00136), sans que l'écart soit établi. La couche de calibration le répare et le résultat devient meilleur que le modèle A (−0,00238), mais **l'intervalle de confiance contient zéro** : [−0,00708 ; +0,00243]. Sur la seule saison de validation disponible, rien ne permet d'affirmer que le 1X2 de SOLEIL s'améliore.

**Quatre raisons, toutes mesurées :**

1. **Le calibrateur n'est pas assez stable.** Ajusté sur les 399 rencontres de 2024/2025, il donne T = 0,61 · c(nul) = 1,30. Ajusté sur 1 520 rencontres (phase 12), il donne T = 0,66 · c(nul) = 1,28. Ajusté sur d'autres découpes, T varie de 0,61 à 0,78. **La direction est constante, l'amplitude ne l'est pas.**
2. **Le gain est de l'ordre de deux millièmes de Brier** — très en dessous de ce qu'un échantillon de 544 rencontres permet de détecter.
3. **La couche de calibration a un coût mesuré** : elle éloigne le 1X2 publié de la distribution des scores de **5,78 % en moyenne** (13,86 % au pire). Un marché qui gagne deux millièmes en Brier en contredisant sa propre distribution de 5,8 points n'est pas une amélioration nette.
4. **Hors échantillon, la calibration n'apporte presque rien** — ni en Brier, ni en fiabilité : l'ECE passe de 2,12 à 2,02, soit **0,10 point**. Le gain d'ECE spectaculairement affiché plus bas (2,27 → 0,66) est mesuré sur les données ayant servi à ajuster le calibrateur : **c'est un potentiel, pas une performance démontrée.**

**Sur les 21 améliorations établies, 19 ne dépendent d'aucun calibrateur** : elles viennent du xG seul, et ce sont elles qui fondent la décision.

**Conclusion opérationnelle :** adopter le xG **sur les marchés de buts**, où la preuve est solide. Sur le 1X2, **la décision ne peut pas être prise sur ces données** — il faut soit plus de rencontres avec xG, soit renoncer à la couche de calibration et retenir le 1X2 dérivé de la distribution des scores, qui est cohérent par construction.

---

# 1 · PROTOCOLE ET GARANTIES

| Exigence | Application |
| --- | --- |
| **§1 — moteur intact** | Aucun fichier de `src/server/engine/` modifié — vérifié par horodatage, faute de dépôt Git : les 7 fichiers du moteur portent l'horodatage du redéploiement du bac à sable (00:19), et seuls **5 fichiers** ont été touchés par cette phase : `scripts/backtest/phase13.ts` (nouveau), `scripts/backtest/pipeline.ts`, `package.json` et les deux rapports. Le moteur n'en fait pas partie. |
| **§2 — zéro crédit** | Lecture des fichiers locaux, du cache et des 460 rencontres enrichies en phase 11. Aucune requête réseau. |
| **§3 — effectif identique** | **943 rencontres appariées**, vérifiées une par une par identifiant. A et B reçoivent exactement le même contexte, les mêmes résultats réels, les mêmes informations pré-match. |
| **§10 — mi-temps** | **943 / 943** rencontres ont un score de mi-temps réel. Aucune reconstruction. |
| **§11 — 2e mi-temps** | Buts de 2e période = score final − score de mi-temps. **Une soustraction de données réelles**, jamais une invention. 943 / 943 calculables. |
| **§17 — pas de data snooping** | Le paramètre testé est celui fixé : **xG 20 % + récence (demi-vie 3) + calibration phase 12**. Aucun autre poids essayé. Aucune variante sélectionnée après observation. |

## Échantillon

| | |
| --- | --- |
| Rencontres de test évaluées | 2 280 (Premier League + LaLiga, 2023/24 → 2025/26) |
| **Rencontres retenues** | **943** — celles où le xG est réellement actif |
| Écartées | 1 337 — le modèle B y est **identique** au modèle A (xG inapplicable) ; les inclure noierait l'effet mesuré |
| Premier League / LaLiga | 622 / 321 |
| 2024/2025 / 2025/2026 | 399 / 544 |

**Modèle A :** moteur actuel, sans signal xG.
**Modèle B :** xG 20 % + pondération par récence (demi-vie 3 matchs) + calibration 1X2 ajustée sur sa propre sortie.

**Convention de lecture :** dans la colonne *Meilleur*, **gras** = différence statistiquement établie (IC 95 % excluant zéro), texte simple = écart observé mais non concluant, `=` = écart nul. Δ négatif = **modèle B meilleur**. IC à 95 % par bootstrap apparié, graine 20260929 — même méthode que les phases 11 et 12.

---

# 2 · TABLEAU PRINCIPAL (§19)

**Tous les marchés, mêmes 943 rencontres, appariées.** Brier, sauf le score exact (Log Loss).

## 1X2

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| 1X2 — B brut | 943 | 0,6009 | 0,6021 | +0,00121 | [−0,00110 ; +0,00341] | 0.14 | A |
| 1X2 — B calibré | 943 | 0,6009 | 0,5957 | −0,00517 | [−0,00992 ; −0,00045] | 0.98 | **B** |
| 1X2 (matrice) — B brut | 943 | 0,6006 | 0,6017 | +0,00103 | [−0,00125 ; +0,00318] | 0.18 | A |
| 1X2 (matrice) — B calibré | 943 | 0,6006 | 0,5958 | −0,00479 | [−0,00956 ; −0,00006] | 0.98 | **B** |

> ⚠️ **Les deux lignes « B calibré » utilisent un calibrateur ajusté sur la portion 2024/2025 des 943 rencontres elles-mêmes.** Elles sont donc **optimistes par construction**. La mesure honnête — calibrateur pré-enregistré en phase 12, appliqué hors échantillon — est au **§3.1**, et elle est nettement moins favorable. Les autres 39 lignes du tableau n'utilisent **aucun calibrateur** et ne sont pas concernées.

## Over/Under total

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| O/U total 0,5 | 943 | 0,0434 | 0,0433 | −0,00016 | [−0,00029 ; −0,00004] | 1.00 | **B** |
| O/U total 1,5 | 943 | 0,1649 | 0,1641 | −0,00086 | [−0,00153 ; −0,00021] | 1.00 | **B** |
| O/U total 2,5 | 943 | 0,2461 | 0,2446 | −0,00151 | [−0,00266 ; −0,00043] | 0.99 | **B** |
| O/U total 3,5 | 943 | 0,2076 | 0,2061 | −0,00148 | [−0,00248 ; −0,00037] | 1.00 | **B** |
| O/U total 4,5 | 943 | 0,1240 | 0,1228 | −0,00118 | [−0,00183 ; −0,00049] | 1.00 | **B** |

## BTTS, buts par équipe, score exact

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| BTTS | 943 | 0,2480 | 0,2464 | −0,00163 | [−0,00251 ; −0,00077] | 1.00 | **B** |
| Domicile > 0,5 | 943 | 0,1672 | 0,1665 | −0,00071 | [−0,00143 ; +0,00000] | 0.97 | B |
| Extérieur > 0,5 | 943 | 0,1858 | 0,1849 | −0,00084 | [−0,00176 ; +0,00007] | 0.97 | B |
| Domicile > 1,5 | 943 | 0,2351 | 0,2345 | −0,00058 | [−0,00183 ; +0,00064] | 0.83 | B |
| Extérieur > 1,5 | 943 | 0,2252 | 0,2245 | −0,00067 | [−0,00185 ; +0,00046] | 0.88 | B |
| Domicile > 2,5 | 943 | 0,1538 | 0,1534 | −0,00039 | [−0,00137 ; +0,00063] | 0.76 | B |
| Extérieur > 2,5 | 943 | 0,0997 | 0,0989 | −0,00081 | [−0,00153 ; −0,00010] | 0.99 | **B** |
| Score exact | 943 | 2,9076 | 2,9019 | −0,00566 | [−0,01007 ; −0,00113] | 0.99 | **B** |

## Première mi-temps — 943 rencontres, score de mi-temps réel

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| 1X2 1re mi-temps | 943 | 0,6401 | 0,6406 | +0,00054 | [−0,00108 ; +0,00211] | 0.27 | A |
| 1re mi-temps O/U 0,5 | 943 | 0,1950 | 0,1948 | −0,00016 | [−0,00070 ; +0,00038] | 0.73 | B |
| 1re mi-temps O/U 1,5 | 943 | 0,2266 | 0,2257 | −0,00091 | [−0,00167 ; −0,00016] | 0.99 | **B** |
| 1re mi-temps O/U 2,5 | 943 | 0,1157 | 0,1154 | −0,00029 | [−0,00067 ; +0,00011] | 0.93 | B |
| 1re mi-temps BTTS | 943 | 0,1576 | 0,1572 | −0,00045 | [−0,00087 ; −0,00004] | 0.98 | **B** |
| 1re mi-temps domicile > 0,5 | 943 | 0,2427 | 0,2428 | +0,00014 | [−0,00074 ; +0,00098] | 0.38 | A |
| 1re mi-temps extérieur > 0,5 | 943 | 0,2426 | 0,2416 | −0,00097 | [−0,00188 ; −0,00009] | 0.98 | **B** |
| 1re mi-temps domicile > 1,5 | 943 | 0,1374 | 0,1377 | +0,00030 | [−0,00033 ; +0,00092] | 0.17 | A |
| 1re mi-temps extérieur > 1,5 | 943 | 0,0819 | 0,0816 | −0,00025 | [−0,00064 ; +0,00013] | 0.91 | B |
| 1re mi-temps domicile > 2,5 | 943 | 0,0369 | 0,0369 | +0,00001 | [−0,00013 ; +0,00016] | 0.48 | A |
| 1re mi-temps extérieur > 2,5 | 943 | 0,0211 | 0,0211 | −0,00001 | [−0,00011 ; +0,00010] | 0.60 | B |
| Score exact 1re mi-temps | 943 | 2,0621 | 2,0614 | −0,00068 | [−0,00377 ; +0,00237] | 0.68 | B |

## Deuxième mi-temps — buts = score final − score de mi-temps

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| 1X2 2e mi-temps | 943 | 0,6472 | 0,6469 | −0,00028 | [−0,00195 ; +0,00144] | 0.62 | B |
| 2e mi-temps O/U 0,5 | 943 | 0,1550 | 0,1545 | −0,00056 | [−0,00100 ; −0,00012] | 1.00 | **B** |
| 2e mi-temps O/U 1,5 | 943 | 0,2530 | 0,2519 | −0,00104 | [−0,00192 ; −0,00016] | 0.99 | **B** |
| 2e mi-temps O/U 2,5 | 943 | 0,1539 | 0,1529 | −0,00099 | [−0,00157 ; −0,00041] | 1.00 | **B** |
| 2e mi-temps BTTS | 943 | 0,2008 | 0,1999 | −0,00094 | [−0,00150 ; −0,00035] | 1.00 | **B** |
| 2e mi-temps domicile > 0,5 | 943 | 0,2461 | 0,2449 | −0,00125 | [−0,00220 ; −0,00033] | 1.00 | **B** |
| 2e mi-temps extérieur > 0,5 | 943 | 0,2429 | 0,2425 | −0,00032 | [−0,00119 ; +0,00062] | 0.75 | B |
| 2e mi-temps domicile > 1,5 | 943 | 0,1636 | 0,1630 | −0,00068 | [−0,00145 ; +0,00007] | 0.96 | B |
| 2e mi-temps extérieur > 1,5 | 943 | 0,1385 | 0,1383 | −0,00017 | [−0,00083 ; +0,00045] | 0.70 | B |
| 2e mi-temps domicile > 2,5 | 943 | 0,0456 | 0,0453 | −0,00028 | [−0,00050 ; −0,00005] | 0.99 | **B** |
| 2e mi-temps extérieur > 2,5 | 943 | 0,0284 | 0,0282 | −0,00019 | [−0,00034 ; −0,00003] | 0.99 | **B** |
| Score exact 2e mi-temps | 943 | 2,2899 | 2,2850 | −0,00498 | [−0,00849 ; −0,00150] | 1.00 | **B** |

## Bilan du tableau

| | Nombre |
| --- | --- |
| Marchés testés | 41 |
| Marchés où le modèle B est **meilleur** | **35 / 41** |
| Marchés où le modèle A est meilleur | 6 / 41 |
| **Améliorations statistiquement établies** | **21** |
| Dégradations statistiquement établies | **0** |
| Différences non concluantes | 20 |

**Aucune dégradation établie nulle part.** Les 6 lignes où A devance B ont toutes un intervalle de confiance contenant zéro : **ce sont des écarts indistinguables du bruit**, pas des reculs démontrés.

---

# 3 · LE 1X2 — DÉCOMPOSITION ET DÉCISION

C'est le marché où la réponse dépend entièrement de **comment** on mesure. Cette section sépare les effets.

## 3.1 Décomposition des effets (calibrateur pré-enregistré de la phase 12)

Le calibrateur utilisé ici est celui **ajusté en phase 12** sur 2023/24 + 2024/25 — donc sur des données antérieures et disjointes de la saison de validation. C'est la lecture la plus fidèle du §3 : « calibration **déjà validée en Phase 12** ».

**Hors échantillon — 544 rencontres de 2025/2026 :**

| Modèle | Brier | Log Loss | ECE |
| --- | --: | --: | --: |
| **A brut (référence)** | 0,6115 | 1,0212 | 2,12 |
| B brut (xG seul) | 0,6129 | 1,0230 | 3,15 |
| A + calibration phase 12 | 0,6111 | 1,0216 | 2,05 |
| **B + calibration phase 12** | 0,6091 | 1,0180 | 2,02 |

| Comparaison | Δ Brier | IC 95 % | Établi ? |
| --- | --: | --- | --- |
| Effet du xG, sans calibration | +0,00136 | [−0,00149 ; +0,00420] | ❌ non |
| Effet de la calibration, sans xG | −0,00039 | [−0,00625 ; +0,00583] | ❌ non |
| Effet de la calibration, avec xG | −0,00375 | [−0,00979 ; +0,00256] | ❌ non |
| Effet du xG, à calibration égale | −0,00199 | [−0,00511 ; +0,00103] | ❌ non |
| Modèle B calibré contre Modèle A brut | −0,00238 | [−0,00708 ; +0,00243] | ❌ non |

**Sur cette saison, aucune comparaison ne franchit le seuil.** Le signe est favorable dans quatre cas sur cinq, mais l'incertitude est du même ordre que l'effet.

**Sur la fiabilité, hors échantillon, le gain est marginal** : l'ECE passe de 2,12 (A brut) à 2,05 (A calibré) puis 2,02 (B calibré) — soit **−0,10 point**, pas davantage. La calibration n'est donc **pas** non plus un gain de fiabilité démontré hors échantillon.

**Pour comparaison, sur le périmètre complet (943 rencontres) :**

| Comparaison | Δ Brier | IC 95 % | Établi ? |
| --- | --: | --- | --- |
| Effet du xG, sans calibration | +0,00121 | [−0,00110 ; +0,00341] | ❌ non |
| Effet du xG, à calibration égale | −0,00281 | [−0,00528 ; −0,00042] | ✅ oui |
| Modèle B calibré contre Modèle A brut | −0,00478 | [−0,00829 ; −0,00122] | ✅ oui |

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
| A brut | 0,2229 | 0,1784 | 0,1997 | **0,6009** | 1,0063 | 2,27 | 0,2440 |
| B brut | 0,2237 | 0,1785 | 0,1998 | **0,6021** | 1,0080 | 3,60 | 0,2466 |
| B calibré | 0,2194 | 0,1783 | 0,1980 | **0,5957** | 0,9988 | 0,66 | 0,2413 |

**Le nul n'est jamais le problème** : son Brier reste à 0,17836 (modèle A), 0,17854 (B brut) et 0,17831 (B calibré). L'hypothèse d'un défaut du nul est **définitivement infirmée**. La calibration agit sur **domicile** (−0,00342) et **extérieur** (−0,00170).

**Fiabilité par tranche, 943 rencontres, toutes issues confondues.**

> ⚠️ Cette table est **optimiste** : le calibrateur y est ajusté sur une partie de ces mêmes données. Elle montre le potentiel de la méthode, pas sa performance démontrée. La lecture hors échantillon est au §3.1.

| Tranche annoncée | A : annoncé → observé | B calibré : annoncé → observé | Écart A → B |
| --- | --- | --- | --- |
| [0,00 ; 0,15) | 0,129 → 0,095 (n=42) | 0,113 → 0,107 (n=177) | 3,4 pt → 0,5 pt |
| [0,15 ; 0,25) | 0,218 → 0,199 (n=803) | 0,207 → 0,212 (n=826) | 1,8 pt → 0,5 pt |
| [0,25 ; 0,35) | 0,290 → 0,283 (n=926) | 0,293 → 0,304 (n=826) | 0,7 pt → 1,0 pt |
| [0,35 ; 0,45) | 0,397 → 0,395 (n=539) | 0,400 → 0,365 (n=394) | 0,2 pt → 3,5 pt |
| [0,45 ; 0,55) | 0,493 → 0,514 (n=315) | 0,498 → 0,507 (n=276) | 2,1 pt → 1,0 pt |
| [0,55 ; 1,01) | 0,614 → 0,696 (n=204) | 0,651 → 0,648 (n=330) | 8,2 pt → 0,2 pt |

**La calibration resserre l'écart dans 4 tranches sur 6**, et l'effet le plus spectaculaire est dans la tranche haute [0,55 ; 1,01) : l'écart passe de 8,2 points à 0,2 point. C'est là que le moteur était le plus malhonnête — il annonçait 0,614 quand la fréquence réelle était 0,696.

**Mais elle dégrade deux tranches centrales** — dont [0,35 ; 0,45) où l'écart monte de 0,2 à 3,5 points. **Le gain de fiabilité n'est donc pas uniforme, et il est en grande partie un artefact d'ajustement.**

---

# 4 · MARCHÉS DE BUTS — LE RÉSULTAT SOLIDE

## Over/Under

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| O/U total 0,5 | 943 | 0,0434 | 0,0433 | −0,00016 | [−0,00029 ; −0,00004] | 1.00 | **B** |
| O/U total 1,5 | 943 | 0,1649 | 0,1641 | −0,00086 | [−0,00153 ; −0,00021] | 1.00 | **B** |
| O/U total 2,5 | 943 | 0,2461 | 0,2446 | −0,00151 | [−0,00266 ; −0,00043] | 0.99 | **B** |
| O/U total 3,5 | 943 | 0,2076 | 0,2061 | −0,00148 | [−0,00248 ; −0,00037] | 1.00 | **B** |
| O/U total 4,5 | 943 | 0,1240 | 0,1228 | −0,00118 | [−0,00183 ; −0,00049] | 1.00 | **B** |

**Les cinq lignes du moteur s'améliorent, et les cinq améliorations sont établies.** C'est le résultat le plus solide de la phase. Le gain culmine sur les lignes 2,5 (−0,00151) et 3,5 (−0,00148) — celles où l'information sur le volume de buts compte le plus. La ligne 0,5 gagne le moins (−0,00016), ce qui est logique : savoir *combien* de buts attendre n'aide guère à savoir s'il y en aura au moins un.

## BTTS

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| BTTS | 943 | 0,2480 | 0,2464 | −0,00163 | [−0,00251 ; −0,00077] | 1.00 | **B** |

**La probabilité de BTTS s'améliore de 1,63 millièmes, et c'est établi** (P = 1.00). Comme BTTS + non-BTTS = 1 exactement (vérifié à 0 sur 1886 cas), le gain porte nécessairement sur les deux issues et non sur une seule.

## Buts par équipe — mesurés indépendamment, jamais déduits du total

| Marché | N | Modèle A | Modèle B | Δ | IC 95 % | P(B<A) | Meilleur |
| --- | --: | --: | --: | --: | --- | --: | --- |
| Domicile > 0,5 | 943 | 0,1672 | 0,1665 | −0,00071 | [−0,00143 ; +0,00000] | 0.97 | B |
| Extérieur > 0,5 | 943 | 0,1858 | 0,1849 | −0,00084 | [−0,00176 ; +0,00007] | 0.97 | B |
| Domicile > 1,5 | 943 | 0,2351 | 0,2345 | −0,00058 | [−0,00183 ; +0,00064] | 0.83 | B |
| Extérieur > 1,5 | 943 | 0,2252 | 0,2245 | −0,00067 | [−0,00185 ; +0,00046] | 0.88 | B |
| Domicile > 2,5 | 943 | 0,1538 | 0,1534 | −0,00039 | [−0,00137 ; +0,00063] | 0.76 | B |
| Extérieur > 2,5 | 943 | 0,0997 | 0,0989 | −0,00081 | [−0,00153 ; −0,00010] | 0.99 | **B** |

**Six lignes sur sept s'améliorent, mais une seule est établie** (−0,00081). Le xG aide davantage le **total** (où les cinq lignes sont établies) que la **répartition** entre les deux équipes. C'est cohérent avec la nature du signal, et c'est exactement pourquoi ces marchés devaient être mesurés séparément : les déduire du total aurait laissé croire à une preuve qui n'existe pas au niveau de chaque ligne.

## Score exact

| Période | N | Log Loss A | Log Loss B | Δ | P(score réel) A | P(score réel) B | Top 1 A | Top 1 B | Top 3 A | Top 3 B |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| FT | 943 | 2,9076 | **2,9019** | −0,00566 | 6,76 % | 6,77 % | 12,2 % | 12,8 % | 31,7 % | 32,0 % |
| HT | 943 | 2,0621 | **2,0614** | −0,00068 | 17,19 % | 17,19 % | 26,7 % | 27,5 % | 66,0 % | 66,1 % |
| SH | 943 | 2,2899 | **2,2850** | −0,00498 | 12,96 % | 12,97 % | 20,4 % | 19,9 % | 54,0 % | 53,6 % |

**Le gain sur le score exact du match complet est établi** (−0,00566 de Log Loss, P = 0.99) et il n'a **pas** été déduit du gain sur l'Over/Under : il est mesuré sur la distribution complète, score par score.

**Ce qui n'est pas annoncé :** aucune « précision » du score exact. **Top 1 = 12,8 %** signifie que le score le plus probable est le bon dans environ un cas sur huit. Le marché reste intrinsèquement incertain, et aucune formulation ne doit laisser croire le contraire.

---

# 5 · COHÉRENCE MATHÉMATIQUE

**1886 cas vérifiés** (943 rencontres × 2 modèles) : chaque marché a été relu dans sa matrice, jamais recalculé à part.

| Invariant | Écart maximal observé |
| --- | --: |
| Somme de la distribution — match complet | **6,7 × 10⁻¹⁶** ✔ |
| Somme de la distribution — 1re mi-temps | **5,6 × 10⁻¹⁶** ✔ |
| Somme de la distribution — 2e mi-temps | **6,7 × 10⁻¹⁶** ✔ |
| P(domicile) + P(nul) + P(extérieur) | **2,2 × 10⁻¹⁶** ✔ |
| P(BTTS) + P(non-BTTS) | **0 exactement** ✔ |
| P(Over) + P(Under) sur chaque ligne | **0 exactement** ✔ |

**Toutes les sommes valent 1 à la précision de la machine.** Aucune incohérence interne.

## Mais il y a une incohérence préexistante — et la calibration l'aggrave

Le moteur publie **deux chemins d'agrégation distincts** : le 1X2 vient de la moyenne pondérée des probabilités des modèles, la distribution de scores vient de la moyenne pondérée des λ. Rien ne garantit qu'ils concordent.

| Comparaison | Écart moyen | Écart maximal |
| --- | --: | --: |
| **Modèle A** — 1X2 moyenné ↔ 1X2 de la matrice | **0,251 %** | 1,88 % |
| **Modèle B calibré** — 1X2 calibré ↔ 1X2 de la matrice | **5,78 %** | 13,86 % |

*Écart = distance de variation totale : 5,78 % signifie que 5,78 points de probabilité s'écartent, en moyenne, de la distribution.*

**Deux faits à documenter exactement, comme le demande le §13 :**

1. **Le moteur actuel est déjà incohérent de 0,251 % en moyenne** entre son 1X2 publié et sa propre distribution de scores. C'est antérieur au xG et ne dépend pas de lui.
2. **La couche de calibration multiplie cet écart par 23** — de 0,251 % à 5,78 % en moyenne, jusqu'à 13,86 % sur certaines rencontres.

**C'est le coût exact de la calibration.** Hors échantillon, elle achète 0,0024 de Brier (**non établi**) et 0,10 point d'ECE (**marginal**), au prix de 5,78 points d'écart entre le 1X2 affiché et la distribution de scores affichée à côté — soit 23 fois l'incohérence introduite. **Ce n'est pas un détail : c'est un marché qui peut contredire son voisin sur un écran.**

**La seule architecture qui supprime ce compromis** — le 1X2 lu dans la matrice, sans transformation — est aussi celle qui donne le 1X2 le plus honnête : 0,6006 contre 0,6009 pour le modèle A actuel, écart nul par construction. Elle est déjà spécifiée dans `docs/architecture-probabiliste-v2.md` et **n'est pas implémentée**.

---

# 6 · ROBUSTESSE TEMPORELLE

Δ Brier (B − A). Négatif = modèle B meilleur.

| Sous-groupe | N | Δ 1X2 calibré | IC 95 % | Δ O/U 2,5 | Δ BTTS |
| --- | --: | --: | --- | --: | --: |
| Premier League | 622 | −0,00549 | [−0,01122 ; +0,00008] | −0,00165 | −0,00113 |
| LaLiga | 321 | −0,00455 | [−0,01304 ; +0,00438] | −0,00123 | −0,00261 |
| 1re moitié de saison | 433 | −0,00895 | [−0,01547 ; −0,00213] | −0,00037 | −0,00133 |
| 2de moitié de saison | 510 | −0,00197 | [−0,00875 ; +0,00479] | −0,00248 | −0,00189 |
| 2024/2025 | 399 | −0,00857 | [−0,01604 ; −0,00134] | −0,00140 | −0,00074 |
| 2025/2026 | 544 | −0,00268 | [−0,00877 ; +0,00344] | −0,00160 | −0,00229 |

**Le signe ne s'inverse dans aucune des six découpes**, ni pour le 1X2, ni pour l'Over/Under 2,5, ni pour le BTTS. C'est le meilleur argument en faveur du xG : sa direction est stable.

**Mais l'amplitude varie fortement sur le 1X2** (−0,00895 à −0,00197), et les deux découpes où l'effet est « établi » (1re moitié, 2024/25) sont aussi celles qui participent à l'ajustement du calibrateur. Le §14 demandait de signaler si le gain disparaît dans une autre période : **il ne disparaît pas, mais il devient indétectable sur la saison la plus récente.**

---

# 7 · CALIBRATION DES MARCHÉS BINAIRES — RÉSULTAT MITIGÉ

Ajustement sur 2024/25, mesure sur 2025/26 — **hors échantillon**.

| Marché | A | B | T ajusté | **B calibré** | ECE B → B calibré | Verdict |
| --- | --: | --: | --: | --: | --- | --- |
| O/U total 0,5 | 0,0421 | 0,0418 | 0,95 | **0,0414** | 2,72 → 1,91 | ✅ |
| O/U total 1,5 | 0,1668 | 0,1656 | 1,07 | **0,1668** | 4,34 → 5,66 | ❌ dégrade |
| O/U total 2,5 | 0,2505 | 0,2489 | 1,06 | **0,2486** | 4,09 → 4,59 | ✅ |
| O/U total 3,5 | 0,1935 | 0,1927 | 0,97 | **0,1925** | 5,22 → 4,45 | ✅ |
| O/U total 4,5 | 0,1127 | 0,1123 | 0,88 | **0,1120** | 2,46 → 1,72 | ✅ |
| BTTS | 0,2504 | 0,2481 | 1,37 | **0,2477** | 4,23 → 4,79 | ✅ |

**Contrairement au 1X2, la calibration binaire n'est pas un gain universel** : elle aide 5 marchés sur 6 et **dégrade** la ligne 1,5. Les températures sont dispersées (0,88 à 1,37) — les marchés de buts ne partagent pas un même biais. **Elle doit donc être appliquée marché par marché, jamais globalement.**

C'est aussi pourquoi elle **n'a pas été intégrée au modèle B du tableau principal** : l'y inclure aurait supposé choisir, après avoir vu les résultats, les marchés sur lesquels elle aide. Le §17 l'interdit, et c'est la bonne règle.

---

# 8 · CE QUI EST ÉTABLI, CE QUI NE L'EST PAS

## Établi — intervalle de confiance excluant zéro

| Résultat | Ampleur |
| --- | --: |
| xG améliore **les 5 lignes Over/Under** | de −0,00016 à −0,00151 |
| xG améliore le **BTTS** | −0,00163 |
| xG améliore **Extérieur > 2,5** | −0,00081 |
| xG améliore le **score exact** (match complet) | −0,00566 |
| xG améliore **3 marchés de 1re mi-temps** | −0,00097 à −0,00045 |
| xG améliore **8 marchés de 2e mi-temps** | −0,00498 à −0,00019 |
| Absence de dégradation établie | **0 / 41** |

Détail des 3 marchés de première mi-temps établis : O/U 1,5, BTTS, extérieur > 0,5.
Détail des 8 marchés de deuxième mi-temps établis : O/U 0,5, O/U 1,5, O/U 2,5, BTTS, domicile > 0,5, domicile > 2,5, extérieur > 2,5, Score exact 2e mi-temps.
Soit **11 marchés de période sur 24** — les marchés de période ne sont donc pas uniformément améliorés, mais aucun ne recule de façon établie.

## Prometteur mais non démontré

| Résultat | Mesure hors échantillon | Statut |
| --- | --- | --- |
| La calibration rend le 1X2 **plus fiable** | ECE 2,12 → 2,02 (0,10 point) | **Marginal** — l'effet spectaculaire (2,27 → 0,66) n'existe que sur les données d'ajustement |
| La calibration **corrige le 1X2** | −0,00238 · IC [−0,00708 ; +0,00243] | **Non établi** sur 544 rencontres |
| Le xG **améliore le 1X2** | −0,00199 à calibration égale | **Non établi** |

## Non établi — l'intervalle contient zéro

| Résultat | Δ observé | IC 95 % |
| --- | --: | --- |
| **1X2 hors échantillon, modèle B calibré contre A** | −0,00238 | [−0,00708 ; +0,00243] |
| **Effet du xG sur le 1X2, à calibration égale** | −0,00199 | [−0,00511 ; +0,00103] |
| Effet du xG brut sur le 1X2 | +0,00136 | [−0,00149 ; +0,00420] |
| 1X2 de 1re mi-temps | +0,00054 | [−0,00108 ; +0,00211] |
| 1X2 de 2e mi-temps | −0,00028 | [−0,00195 ; +0,00144] |
| Score exact de 1re mi-temps | −0,00068 | [−0,00377 ; +0,00237] |
| Buts par équipe non établis (5) | −0,00084 à −0,00039 | contient 0 |

**Aucune cause n'est avancée pour ces résultats non concluants.** L'échantillon ne permet pas de trancher, et l'absence de preuve n'est pas une preuve d'absence.

---

# 9 · ERRATUM SUR LA PHASE 12

En préparant cette phase, j'ai tenté de reproduire le tableau « Comparaison finale » du rapport de phase 12. **Il ne se reproduit pas**, et je dois le signaler.

| | Phase 12 annonçait | Phase 13 recalcule |
| --- | --: | --: |
| A calibré (2025/26) | 0,6122 | 0,6111 |
| B calibré (2025/26) | 0,6107 | 0,6091 |
| Δ | **−0,00039** | **−0,00199** |

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
| **Adopter le xG sur les marchés de buts** — Over/Under, BTTS, score exact | 8 améliorations établies, sans aucun calibrateur, signe constant dans 6 découpes, 5 lignes O/U sur 5 | **Solide** |
| **Adopter le xG sur les marchés de période** (1re et 2e mi-temps) | 11 améliorations établies sur 24 marchés de période, aucune dégradation établie | **Solide**, sauf les marchés 1X2 de période qui ne gagnent rien |
| **Conserver la pondération par récence** (demi-vie 3) | Domine le poids uniforme à poids égal en phase 12 ; confirmée ici sur les marchés de buts | **Solide** |
| **Adopter la calibration 1X2 pour sa fiabilité** | ECE hors échantillon 2,12 → 2,02 seulement | **❌ non démontré** |
| **Adopter la calibration 1X2 pour son Brier** | −0,00238 hors échantillon, intervalle contenant zéro | **❌ non établi** |
| **Appliquer la calibration aux marchés binaires** | Aide 5 marchés sur 6, dégrade la ligne 1,5 | **À faire marché par marché uniquement** |
| **Lancer la couche de calibration en production ?** | Trois mesures négatives convergentes : Brier non établi, ECE marginal, incohérence ×23 | **❌ Non — attendre plus de données** |
| **Dériver le 1X2 de la distribution des scores ?** | Cohérence nulle par construction contre 5,78 % avec calibration ; coût nul | **Recommandé — la seule voie sans compromis** |

## La réponse claire à la question posée

**Oui, le xG à 20 % avec récence améliore SOLEIL — sur les marchés de buts, sans ambiguïté, avec 19 améliorations établies qui ne dépendent d'aucun calibrateur.**

**Sur le 1X2, cette phase ne permet pas de conclure.** Le signe est favorable partout, l'effet est réel mais petit, et l'échantillon disponible — 943 rencontres, dont 544 seulement hors échantillon — ne suffit pas à le distinguer du hasard. **Le dire est plus utile que de publier un chiffre qui arrangerait la conclusion.**

## Ce qu'il faudrait pour trancher le 1X2

1. **Plus de rencontres avec xG.** LaLiga complète (380 rencontres, 380 crédits) porterait le périmètre hors échantillon de 544 à environ 924 — assez pour détecter un effet de deux millièmes. **Cela nécessite votre autorisation d'utiliser une clé au-delà de la première**, la clé 1 n'ayant plus que 2 crédits.
2. **Ou renoncer à la couche de calibration** et retenir le 1X2 dérivé de la distribution, cohérent par construction, mesuré meilleur que l'actuel à tous les poids testés depuis la phase 11.

**Aucune de ces deux voies n'est engagée. Le moteur de production reste inchangé, et aucun import massif n'a été lancé.**

---

# 11 · TRAÇABILITÉ

| Élément | Emplacement |
| --- | --- |
| Résultats complets | `data/backtests/2026-09-30T00-26-52-302Z-phase13/phase13.json` |
| Rejeu par rencontre (943 × 2 modèles) | `data/backtests/2026-09-30T00-26-52-302Z-phase13/records.jsonl` |
| Banc d'essai | `scripts/backtest/phase13.ts` — `npm run backtest:phase13` |
| Générateur de ce rapport | `scripts/backtest/rapport-13-tables.py` — régénère chaque table depuis `phase13.json` (`python3 scripts/backtest/rapport-13-tables.py`) |
| Calibrateurs | `scripts/backtest/calibration.ts` |
| Tests de cohérence | `scripts/backtest/__tests__/coherence.test.ts` — 9 tests |
| Spécification d'architecture | `docs/architecture-probabiliste-v2.md` |
| Rapports antérieurs | `reports/rapport-11-backtest-xg.md` · `reports/rapport-12-architecture-hybride.md` (erratum inclus) |

**Coût : 0 crédit.** Clé 1 : 2 crédits, inchangés. Clés 2 à 18 : jamais utilisées.
**Moteur de production : non modifié.** Aucun import massif. `npx tsc --noEmit` : 0 erreur. **137 tests au vert.**
