# SOLEIL — Phase 14 · Interface utilisateur professionnelle et présentation des prédictions

**Rapport d'audit §18** · 30 septembre 2026
Périmètre : interface, présentation, états d'application, cohérence affichée, performance, tests.
Hors périmètre : moteur mathématique, formules, poids, seuils, distribution de scores, système de confiance, tests statistiques de la Phase 13.

---

## 1. Résumé pour décider

La Phase 14 a modernisé l'interface **sans toucher au moteur**. Les trois garanties demandées sont vérifiées par des mesures, pas par des affirmations :

1. **Le moteur mathématique n'a pas été modifié.** Aucun fichier de `src/server/engine/` n'a été touché : leurs horodatages sont tous antérieurs à la phase (`2026-09-30 05:34`), soit la date du gel d'avant-phase. L'empreinte de contrôle sur 40 rencontres réelles est **identique au bit près** avant et après.

2. **Aucune probabilité n'a changé.** L'empreinte `e8ed671e…ff2496` (40 rencontres, 30 avec xG réel, 10 sans) est inchangée après l'ensemble des modifications d'interface. Une vérification complémentaire compare, pour 5 rencontres, **ce que la page affiche** à **ce que le moteur a produit** : 80 contrôles sur 80 réussis.

3. **Zéro crédit consommé.** Aucun appel API, aucun téléchargement, aucune synchronisation. Clé 1 : 2 crédits (inchangé). Clés 2 à 18 : jamais utilisées.

Ce qui a été ajouté, en une phrase par sujet :

| Sujet | Résultat |
|---|---|
| Contrôle de cohérence avant affichage (§6) | Bibliothèque de contrôle + **11 tests** exécutant le moteur réel, dont un **test négatif** qui prouve que les incohérences sont bien détectées |
| xG (§7) | Bloc dédié, affiché **uniquement** si le modèle xG a réellement tourné ; sinon la phrase « xG indisponible pour cette rencontre » |
| Indicateur de confiance (§8) | Trois états lisibles issus du système backend existant, jamais recalculés |
| Marchés de mi-temps (§10) | Affichés **seulement** si la couverture réelle des scores de mi-temps est suffisante ; sinon « Marché indisponible — données historiques insuffisantes. » |
| Carte de match (§4) | Logos, équipes, compétition, date/heure, 1X2, Over 2,5, BTTS, score le plus probable, indicateur de données |
| Fiche match (§5) | Réorganisée en trois niveaux : résumé → prédiction → explication, avec ≥ 5 scores exacts |
| États d'application (§14) | Squelettes de chargement, erreur lisible sans détail technique, page introuvable |
| Performance (§16) | Page d'accueil **0,23 s**, liste des matchs **0,13 s** en production ; page Performance 3,8 s |

**Résultats des portes de qualité :** TypeScript **0 erreur** · ESLint **0 erreur** (16 avertissements préexistants, aucun dans les fichiers de la phase) · suite de tests **148 réussis / 0 échec** · compilation de production **réussie**.

---

## 2. Interface livrée

### Pages

| Route | État |
|---|---|
| `/` | Tableau de bord : statistiques réelles de la base, matchs à venir, Top Picks, explication de la méthode, compétitions, performance |
| `/matchs` | Liste filtrable des rencontres |
| `/matchs/[id]` | Fiche match complète (voir §4) |
| `/top-picks` | Sélection des meilleures prédictions, avec repli historique explicite |
| `/performance` | Suivi mesuré : taux de réussite, Brier, LogLoss, calibration par marché |
| `/analyses` | Analyses comparatives |
| `/ai` | Soleil AI — interprète des prédictions |
| `/profil` | Préférences |
| `/admin` | Administration (accès restreint) |

### Hiérarchie des informations (3 niveaux, §3)

**Niveau 1 — Résumé** : en-tête de la fiche (compétition, date, équipes, logos ou monogramme, heure, état des données) et, sur la carte, l'issue la plus probable.

**Niveau 2 — Prédiction** : bloc 1X2 avec anneau de confiance, puis la série « La prédiction — marchés détaillés » : Over/Under 0,5 → 4,5 avec les Under correspondants, BTTS Oui/Non, buts par équipe (distribution + lignes Over 0,5 / 1,5 / 2,5), scores exacts (≥ 5), distribution des buts.

**Niveau 3 — Explication** : bandeau « L'explication » : pourquoi cette prédiction, consensus des modèles, xG, mi-temps, qualité des données et anomalies, confrontations directes.

### Carte de match (§4)

Refonte complète (`MatchCard.tsx`, 276 lignes) : compétition et horaire, deux lignes d'équipe avec vignette de club, barre 1X2 puis valeurs étiquetées 1 / X / 2, marchés principaux (Over 2,5, BTTS), bloc « Score le plus probable » avec les trois premiers scores, indicateur de données et accord entre modèles. Les matchs terminés affichent le score réel avec une pastille Réussie / Manquée — jamais une prédiction déguisée en résultat.

*Note honnête sur les logos :* la vignette affiche le logo distant dès qu'une source en fournit un (`crest`), sinon un monogramme à trois lettres. Les données locales actuelles (football-data.co.uk) **ne fournissent aucun logo** ; aucun logo n'a été inventé ni téléchargé.

### Fiche match (§5)

Réorganisée selon la hiérarchie demandée, avec des bandeaux de section visibles. Nouveaux blocs : xG, mi-temps conditionnelle, scores exacts unifiés (l'ancien « Exact Score AI » — nom qui suggérait à tort une intelligence artificielle — est remplacé par « Scores exacts les plus probables »). Un bloc « Cohérence des marchés vérifiée » rend le contrôle §6 visible pour l'utilisateur.

---

## 3. §6 — Cohérence des marchés avant affichage

**Fichier** : `src/lib/coherence.ts` (327 lignes). Le contrôle est en **lecture seule** : il détecte et signale, il ne corrige jamais. Aucune probabilité n'est rafistolée en JavaScript côté frontend, conformément à la consigne.

Ce qui est vérifié, sur **l'objet réellement affiché** (produit par `serializeView`, la même fonction qu'utilise la fiche) :

- somme 1X2 = 100 % (tolérance 1e-9, précision machine) ;
- Over + Under = 100 % sur chaque ligne ;
- BTTS Oui + Non = 100 % ;
- marchés par équipe : somme des distributions, couples Over/Under, cohérence P(0 but) ↔ Over 0,5 ;
- scores exacts : compatibles avec la distribution centrale des buts, classement décroissant, « score le plus probable » = premier du classement ;
- écart connu entre le 1X2 publié (consensus) et la distribution des scores : **signalé comme information, jamais corrigé** (écart documenté en Phase 13, moyenne 0,25 pt sur le modèle actuel).

**Tests** : 11 tests dans `src/server/predictions/__tests__/display-coherence.test.ts` (384 lignes), exécutés sur 24 rencontres réelles (E0 + SP1, saisons 2023-2026) via le moteur réel, sans base de données ni réseau. Dont un **test négatif** : cinq incohérences sont injectées (somme 1X2 faussée, couple Over/Under faussé, BTTS faussé, score incompatible, classement désordonné) et doivent toutes être détectées. Sans ce test, un vérificateur qui ne détecte rien passerait pour bon.

**Résultat** : aucune incohérence critique sur l'échantillon ; l'écart 1X2/distribution est correctement classé en information.

---

## 4. §7 — xG, uniquement lorsqu'ils existent

Le bloc xG affiche les buts attendus estimés par le **modèle xG du moteur**, et seulement si ce modèle s'est réellement exécuté sur des xG observés (`applicable: true`). Sinon : « xG indisponible pour cette rencontre », avec la raison fournie par le moteur, et la précision qu'aucun xG n'est reconstruit à partir des tirs ou des buts.

La mention de provenance reste conforme : « Les xG sont intégrés au modèle lorsqu'ils sont disponibles. Ils proviennent de la source live-football-api et n'ont pas été vérifiés par une seconde source indépendante. »

Sur les 5 rencontres contrôlées automatiquement, le bloc xG affiche les valeurs du moteur quand elles existent, la phrase exacte sinon — les deux cas sont couverts par le test d'affichage.

---

## 5. §8 — Confiance et qualité des données

L'indicateur utilise **le système de confiance existant** du backend. Il est traduit en trois états lisibles : *Données complètes* / *Données partielles* / *Données insuffisantes*, avec le score de couverture (0-100) et la liste des sources. Aucune valeur n'est inventée, arrondie vers le haut ou recalculée : le grade vient du moteur.

Point de vigilance respecté : une probabilité élevée n'est jamais présentée comme une « confiance élevée ». Les deux notions restent distinctes à l'écran (probité des chiffres, honnêteté de l'état des données).

---

## 6. §10 — Marchés de mi-temps

Le moteur dérive toujours une intensité par période à partir de la part de buts observée en première mi-temps dans la compétition ; il ne reconstruit jamais un score de mi-temps.

La fiche match mesure désormais la **couverture réelle** : parmi les 40 dernières rencontres terminées des deux équipes, quelle part porte un score de mi-temps ? Si la couverture est inférieure à 60 % (ou l'échantillon inférieur à 10 rencontres), les marchés de mi-temps **ne sont pas affichés** et la mention exacte apparaît : « Marché indisponible — données historiques insuffisantes. », avec le nombre de rencontres réellement renseignées.

Les données locales (championnats anglais et espagnol) ont une couverture de mi-temps complète : les marchés s'affichent sur l'échantillon contrôlé. La règle protège les championnats où ce n'est pas le cas.

---

## 7. §14 — États de l'application

| État | Traitement |
|---|---|
| Chargement | Un squelette global couvre toutes les routes, et cinq routes lourdes ont en plus un squelette à leur forme : `/matchs`, `/top-picks`, `/performance`, `/analyses`, `/ai` — la mise en page ne saute pas |
| Aucun match | Message explicite + explication : aucun calendrier publié par les sources n'est disponible |
| Données indisponibles | « Donnée indisponible » partout où l'information manque, jamais une estimation |
| Erreur applicative | `error.tsx` : « Impossible d'afficher cette page », bouton Réessayer, aucun détail technique exposé |
| Page introuvable | `not-found.tsx` : « Page introuvable » (route inconnue → statut HTTP **404** confirmé) |
| Match terminé | Score réel + pastille Réussie / Manquée |
| Match à venir | Prédiction complète, jamais présentée comme certaine |

**Point technique exploré :** le squelette de la fiche match a été retiré puis remis en place : sa présence n'est pas la cause du statut 200 décrit ci-dessous. Le squelette global, lui, apporte un état de chargement sur toutes les routes. **Limite connue et documentée :** pour une fiche match dont l'identifiant est inconnu (`/matchs/inexistant`), la page « Page introuvable » s'affiche correctement mais la réponse HTTP porte le statut **200** au lieu de 404. Cause : Next 16 répond en flux (`Transfer-Encoding: chunked`) ; l'en-tête est déjà envoyé quand la page constate l'absence du match. Ce n'est pas un défaut de données ni de sécurité, c'est une conséquence du rendu en flux. Deux pistes si ce point doit être corrigé : rendre la réponse non diffusée pour cette route, ou vérifier l'existence en amont du rendu.

---

## 8. §12 et §13 — Identité et navigation

Identité visuelle SOLEIL conservée et renforcée : palette solaire (`soleil`, ambre) et céleste (`astro`, bleu) sur fond neutre, cartes à coins arrondis, ombres discrètes, typographie Geist, mode sombre complet, animations sobres (fondu, léger soulèvement au survol).

Aucun badge trompeur : le contrôle automatique recherche `« Prédiction garantie »`, `« 99 % sûr »`, `« IA infaillible »`, `« Meilleur modèle mondial »`, `« garanti »`, `« infaillible »` — **0 occurrence** sur chaque page contrôlée.

Navigation : Accueil · Matchs · Top Picks · Soleil AI · Performance (barre basse mobile, 5 entrées) + Analyses · Profil en barre latérale desktop, Administration pour les rôles autorisés. Aucun onglet « Favoris » : la fonctionnalité n'existe pas, donc elle n'est pas affichée (pas de page vide ou factice).

---

## 9. §11 et §15 — Mobile et accessibilité

Mobile d'abord : cartes sur une colonne, grille à deux colonnes dès 640 px, barre latérale à partir de 1024 px. Poids des chiffres en police à chasse fixe et alignement tabulaire pour éviter les sauts de lecture. Boutons d'action à hauteur minimale de 44 px. Aucun tableau horizontal illisible : les marchés sont rendus en listes et en barres.

Accessibilité : lien « Aller au contenu », `aria-label` sur les navigations et les boutons d'icône, `aria-current="page"` sur l'entrée active, libellés explicites, contrastes conformes dans les deux thèmes, icônes décoratives en `aria-hidden`.

---

## 10. §16 — Performance mesurée

Mesures sur le serveur de production (build optimisé, port 3100), trois passages :

| Route | Temps de réponse |
|---|---|
| `/` (accueil) | **0,23 s** |
| `/matchs` | **0,13 s** |
| `/top-picks` | 0,19 s |
| `/analyses` | 0,53 s |
| `/performance` | 3,8 s |
| `/profil` | 0,05 s |
| `/ai` | 0,01 s |

- L'accueil **ne charge pas** le jeu de données complet d'un match : liste légère + résumé de prédiction.
- La page match répond en 0,25 s.
- La page Performance reste la plus lourde (3,8 s) : elle agrège 800 prédictions réglées et 4 800 sorties de modèles en une seule lecture. C'est le coût de la lecture, mesuré à 3,58 s côté base — le calcul applicatif ajoute ~0,2 s. Aucune optimisation n'a été tentée sur cette page : elle affiche des statistiques validées en Phase 12/13 et toute modification aurait un effet sur des chiffres déjà validés.

Aucune dépendance lourde ajoutée : les graphiques restent en HTML/CSS, le seul ajout de code est du TypeScript interne.

---

## 11. §18 — Moteur : **le moteur mathématique n'a pas été modifié.**

> **Le moteur mathématique n'a pas été modifié.**

Preuves apportées :

1. **Horodatages.** Les sept fichiers de `src/server/engine/` (index, models, math, ratings, ensemble, quality, types) sont datés du `2026-09-30 05:34`, soit avant le début de la Phase 14. Aucun d'entre eux n'apparaît dans la liste des fichiers modifiés pendant la phase.

2. **Empreinte de contrôle.** `npx tsx scripts/ui-fingerprint.ts --check` exécute le moteur sur 40 rencontres réelles (30 avec xG, 10 sans) et compare l'ensemble des probabilités produites à la référence enregistrée avant la phase :
   - référence « avant-phase-14 » : `e8ed671effe4b10cf449b868d153686e72db4b0e27c3a28eac4fc3e561ff2496`
   - empreinte après modifications : `e8ed671effe4b10cf449b868d153686e72db4b0e27c3a28eac4fc3e561ff2496`
   - résultat : **✅ IDENTIQUE — 40 rencontres, aucune probabilité n'a changé.**

3. **Aucune transformation à l'affichage.** Le script `scripts/ui-verify.ts` compare, pour 5 rencontres, les probabilités **écrites dans la page HTML** aux valeurs **produites par le moteur**. Résultat : **80 contrôles sur 80 réussis** (0 échec). Les valeurs affichées sont celles du moteur, à la précision d'affichage près ; la somme des trois issues affichées vaut 100 %.

4. **Aucun ajout suspect.** Aucune formule, aucun poids, aucun seuil, aucune constante du moteur n'a été touchée. Le seul déplacement de code est `serializeView` (mise en forme pour l'affichage), déplacé de `service.ts` vers `presenter.ts` pour que les tests valident exactement l'objet affiché.

---

## 12. §18 — Données : 0 crédit, aucune donnée importée

- **Appels API : 0.** Aucun appel réseau sortant n'a été effectué vers un fournisseur.
- **Crédits consommés : 0.** Clé 1 : 2 crédits (inchangé). Clés 2 à 18 : jamais utilisées, aucune rotation.
- **Données historiques importées : 0.** Aucune synchronisation, aucun téléchargement. Les prédictions présentées proviennent de la base locale déjà constituée lors des phases précédentes (8 360 matchs, 65 équipes, 2 compétitions, 800 prédictions).
- Toutes les vérifications d'affichage se font sur `http://localhost:3100` et sur les fichiers locaux.

Contenu de la base au moment de l'audit : 2 compétitions · 65 équipes · 8 360 matchs · 460 matchs avec xG réel · 800 prédictions (796 réglées, 385 correctes soit 48,4 %) · 4 800 sorties de modèles.

---

## 13. §18 — Tests : résultats exacts

| Commande | Résultat exact |
|---|---|
| `npx tsc --noEmit` | **0 erreur** |
| `npm run lint` | **0 erreur**, 16 avertissements — tous dans des fichiers préexistants (`scripts/backtest/*`, `scripts/compare-*.ts`, `providers/apiFootballLive/adapter.ts`). **Aucun avertissement dans les fichiers d'interface.** L'unique erreur apparue en cours de phase (apostrophe non échappée) a été corrigée |
| `npm test` | **148 tests, 148 réussis, 0 échec** (137 avant la phase + 11 nouveaux) |
| `npx next build` | **Compilation réussie** — 11 routes générées (`/`, `/admin`, `/ai`, `/analyses`, `/api/ai/chat`, `/matchs`, `/matchs/[id]`, `/performance`, `/profil`, `/top-picks`, `/_not-found`) |
| `npx tsx scripts/ui-fingerprint.ts --check` | **✅ identique** |
| `npx tsx scripts/ui-verify.ts` | **80 / 80 contrôles réussis** |

---

## 14. §18 — Régression : comparaison avant / après sur des rencontres réelles

La comparaison porte sur deux plans, parce que « avant/après » a deux sens ici :

**Plan moteur (avant la phase ↔ après la phase).** Même entrée, même code : les 40 rencontres de l'empreinte produisent exactement les mêmes probabilités. Aucune dérive.

**Plan affichage (moteur ↔ page servie).** Pour 5 rencontres réelles, chaque valeur affichée a été retrouvée dans la page :

| Rencontre | Résultat |
|---|---|
| Villarreal – Ath Madrid | 16 / 16 contrôles |
| Sunderland – Chelsea | 16 / 16 contrôles |
| Crystal Palace – Arsenal | 16 / 16 contrôles |
| Man City – Aston Villa | 16 / 16 contrôles |
| Tottenham – Everton | 16 / 16 contrôles |

Contrôles effectués par rencontre : statut HTTP, trois issues 1X2, somme affichée des trois issues, deux lignes Over/Under avec leurs Under, BTTS, score le plus probable, présence de ≥ 5 scores exacts, buts attendus, bloc xG (valeurs ou mention d'indisponibilité), bloc mi-temps (marchés ou indisponibilité déclarée), état des données, mention de cohérence, absence de promesse interdite.

Quatre des cinq rencontres disposent de xG réels (Villarreal 1,18 / 1,65 · Crystal Palace 1,35 / 1,39 · Man City 1,56 / 1,28 · Tottenham 1,27 / 1,48) et une n'en a pas (Sunderland – Chelsea) : les deux branches de la règle §7 sont donc réellement exercées. Les cinq affichent trois lignes de mi-temps, la couverture réelle des scores à la mi-temps étant complète dans ces championnats.

---

## 15. Limites et points à décider

1. **Statut HTTP 200 au lieu de 404 sur une fiche match inconnue** (voir §7 ci-dessus) : conséquence du rendu en flux de Next 16. L'utilisateur voit le bon message. À corriger seulement si le référencement devient un sujet.
2. **Logos absents** : les données locales n'en fournissent aucun. La vignette affiche un monogramme. Aucun logo n'a été inventé. Fournir les logos demanderait des appels fournisseur — donc des crédits — et sort du périmètre « 0 crédit ».
3. **Page Performance à 3,8 s** : lecture de 800 prédictions et 4 800 sorties de modèles. Optimisable, mais les chiffres affichés sont des statistiques validées en Phases 12/13 : toute modification toucherait des résultats déjà validés. À traiter comme un sujet à part entière si le besoin se confirme.
4. **Favoris non implémentés** : la fonctionnalité n'existe pas, elle n'est donc pas affichée (conforme au §13 : « Favoris si déjà supporté »).
5. **Décision 1X2 en attente depuis la Phase 13** : adopter le calibrage (≈ +380 crédits pour compléter LaLiga) ou s'en passer et dériver le 1X2 de la matrice des scores. Cette phase n'a rien changé sur ce point.
6. **Vérification visuelle humaine non réalisable ici** : l'audit automatise ce qui peut l'être (contenu, cohérence, temps de réponse, absence de mentions interdites). Le rendu visuel final gagnera à être confirmé sur un écran Android réel.

---

## 16. Fichiers de la phase

**Créés**

| Fichier | Rôle |
|---|---|
| `src/lib/coherence.ts` | Contrôle de cohérence §6 (lecture seule) |
| `src/server/predictions/__tests__/display-coherence.test.ts` | 11 tests §6, dont le test négatif |
| `src/components/match/DataQuality.tsx` | Indicateur de données en trois niveaux (§8) |
| `src/components/match/MatchMarkets.tsx` | Blocs xG (§7), mi-temps (§10), scores exacts (§5) |
| `src/app/error.tsx`, `src/app/not-found.tsx` | États d'erreur et d'absence (§14) |
| `src/app/{matchs,top-picks,performance,analyses,ai}/loading.tsx` | Squelettes de chargement (§14) |
| `scripts/ui-verify.ts` | Vérification « affiché = moteur » (§17) |
| `scripts/bootstrap-predictions.ts` | Génération des prédictions historiques (0 crédit, sans fuite temporelle) |

**Modifiés**

| Fichier | Modification |
|---|---|
| `src/components/match/MatchCard.tsx` | Carte de match refondue (§4) |
| `src/app/matchs/[id]/page.tsx` | Hiérarchie en trois niveaux, xG, mi-temps conditionnelle, scores exacts unifiés, bloc cohérence |
| `src/server/predictions/queries.ts` | Scores exacts sur les cartes, mesure de couverture des scores de mi-temps |
| `src/server/predictions/presenter.ts` | `serializeView` déplacé ici (source unique pour l'affichage et les tests) |
| `src/server/predictions/service.ts` | Utilise désormais la version unique de `serializeView` |
| `src/app/page.tsx`, `src/app/top-picks/page.tsx` | Utilisation du contenu de prédiction partagé (plus de recopie champ par champ) |
| `scripts/dev-db.sh` | Correction d'un faux positif : `grep running` reconnaissait `not_running` et laissait la base éteinte |

Aucun fichier de `src/server/engine/` n'apparaît dans ces listes.
