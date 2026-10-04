# RAPPORT §22 — Audit du fournisseur « API Football Live »

**Fournisseur** LiveFootballApi — `https://live-football-api.com/api/v1`
**Date de l'audit** 29 septembre 2026
**Méthode** sonde de 24 appels réels, tracés en base, planifiée pour minimiser la dépense
**Crédits consommés : 24** sur 9 000 disponibles (18 clés × 500 crédits offerts) — soit **0,27 %**
**Décompte vérifié** le solde annoncé par le fournisseur décroît exactement de 1 par appel (`499 → 486`) : le coût annoncé correspond au coût réel
**Import de données : AUCUN.** Ce rapport est établi, comme exigé, **avant** toute synchronisation.

> **Une donnée absente reste absente.** Ce rapport ne comble aucune case vide par une estimation : chaque « non » est un non mesuré, chaque « inconnu » est signalé comme tel.

---

## 1. Réponses directes aux questions posées

| Question | Réponse | Preuve |
|---|---|---|
| **Statistiques disponibles ?** | **OUI — 32 statistiques** par match | Énumérées en §3 |
| **xG disponible ?** | **OUI** | `Expected Goals (xG) : domicile 1.66 / extérieur 2.99` sur un match réel |
| **xG par mi-temps ?** | **NON** | Aucun libellé par mi-temps dans les 32 |
| **Buts par mi-temps ?** | **NON** directement — mais **reconstituable** | Les buts portent leur minute (4 buts sur 16 événements, tous horodatés) → 1re/2e mi-temps dérivables |
| **Corners ?** | **OUI** | Libellé `Corners` |
| **Statistiques à la mi-temps ?** | **NON** — pas de relevé figé à la pause | Les statistiques sont un instantané, pas un historique de périodes |
| **Score à la mi-temps ?** | **OUI, mais inégal selon les compétitions** | 98 % en Angleterre, **0 % au Togo**, 1 % au Ghana — voir §5 |
| **Historique ?** | **EXCEPTIONNEL** | Premier League : **115 saisons annoncées, jusqu'à 1901/1902** |
| **Matchs à venir ?** | **OUI** | Samedi prochain : 786 rencontres ; Premier League 2026/2027 : 330 matchs à venir |
| **Direct ?** | **OUI** (documenté, **non développé** conformément à la consigne) | 4 matchs en direct observés dans la journée du jour |
| **Logos des clubs ?** | **OUI** | `https://live-football-api.com/teams/<id>.png` — vérifié : HTTP 200, PNG 15 Ko |
| **Logos des compétitions ?** | **OUI** | `https://live-football-api.com/leagues/<id>.png` — vérifié : HTTP 200 |
| **Photos des joueurs ?** | **OUI** | `https://live-football-api.com/people/<id>.png` |
| **Drapeaux des pays ?** | **NON** | Aucun champ `flag` dans aucune réponse. La compétition est rattachée à un **nom** de pays, sans image. |

---

## 2. Table des endpoints — mesurée, pas recopiée

Statut : ✅ **testé sur données réelles** · 📄 **documenté par le fournisseur, non testé** (aucun crédit engagé).

| Endpoint | Méthode | Paramètres | Données renvoyées | Coût | Limites | Profondeur d'historique | Futur | Direct |
|---|---|---|---|---|---|---|---|---|
| `/leagues` | GET | `lang` | **159 pays, 1 416 compétitions**, groupées par pays, avec logo de compétition | 1 | — | Catalogue courant | — | — |
| `/matches` | GET | `date` (AAAA-MM-JJ), `lang` | **Toutes les rencontres d'une journée**, toutes compétitions : id, compétition, journée, horaire, statut, équipes + logos, **score**, **score à la mi-temps**, tirs au but, diffusion | 1 | 1 jour par appel | 1 date par appel | **OUI** (samedi suivant : 786 matchs) | **OUI** (`is_live`, `state`, minute) |
| `/live_match_details` | GET | `match_id`, `lang` | **32 statistiques**, **chronologie** des événements, stade, arbitre, homme du match, lien CSB | 1 | **1 match par appel** | **Permanent** (encore disponible après le coup de sifflet final) | — | **OUI** |
| `/league_standings` | GET | `league_id`, `season`, `lang` | Classement complet + **classement domicile** + **classement extérieur** + **liste des saisons disponibles** | 1 | — | **Premier League : 115 saisons (1901/1902 →)** | — | Rafraîchi côté fournisseur |
| `/league_fixtures` | GET | `league_id`, `season`, `week`, `lang` | **Saison entière en 1 appel** (380 matchs pour la Premier League) : résultats + calendrier à venir + mi-temps | 1 | — | 115 saisons | **OUI** (jusqu'au 30/05/2027) | — |
| `/team_matches` | GET | `team_id`, `season`, `lang` | Rencontres d'une équipe sur une saison (résultats + à venir) + saisons disponibles | 1 | — | Selon compétition | **OUI** | — |
| `/team_standings` | GET | `team_id`, `lang` | Position de l'équipe dans son/ses championnat(s) | 1 | **Champ `form` vide** dans ce endpoint | Oui | — | — |
| `/h2h` | GET | `match_id`, `lang` | Confrontations directes + **forme récente des deux équipes** + synthèse V/N/D | 1 | **Indexé par `match_id`**, pas par équipes | Selon match | — | — |
| `/csb` | GET | `token`, `matchid` | Tableau de bord visuel (iframe) | 1 | Jeton valable ~4 h | — | — | **OUI** |
| `/lineups` | GET | `match_id`, `lang` | Onze de départ, remplaçants, entraîneur, formation | 1 | Disponible ~1 h avant le coup d'envoi | — | **OUI** | 📄 |
| `/injuries` | GET | `match_id`, `lang` | Blessures et suspensions | 1 | — | — | **OUI** | 📄 |
| `/officials` | GET | `match_id`, `lang` | Arbitre + officiels, moyennes de cartons de l'arbitre | 1 | — | — | **OUI** | 📄 |
| `/referee` | GET | `referee_id` | Fiche arbitre (cartons, fautes, penaltys) | 1 | — | Oui | — | 📄 |
| `/team_squad` | GET | `team_id`, `season` | Effectif + encadrement | 1 | — | Selon équipe | — | 📄 |
| `/team_search`, `/player_search` | GET | `q` | Recherche d'équipes / de joueurs | 1 | — | — | — | 📄 |
| `/player`, `/player_matches` | GET | `player_id`, `team_id`, `season` | Profil, carrière, matchs par match | 1 | — | Selon joueur | — | 📄 |
| `/webhook/register` | POST/GET/DELETE | `webhook_url`, `label`, `id` | Notification **à chaque but** d'un match en direct | **0 à l'inscription** · **1 par but notifié** | IP source `45.94.4.69` | — | — | **OUI** |

**Vérification préalable gratuite** : les 13 chemins d'API ont été testés **sans clé** (réponse `401 API key is required`) et `/csb` a révélé son contrôle de paramètres (`400 token and matchid parameters are required`). Aucun crédit n'a été dépensé pour découvrir qu'un endpoint n'existe pas.

---

## 3. Les 32 statistiques réellement renvoyées

Liste **complète et littérale**, relevée sur un match en direct **et** sur un match terminé (identique dans les deux cas, à l'exception des valeurs) :

`Aerial Duels Won` · `Big Chances Missed` · `Blocked Shots` · `Clearances` · `Corners` · `Crosses` · `Direct Red Card` · `Duels Won` · **`Expected Goals (xG)`** · `Fouls` · `Goal Kicks` · `Hit Woodwork` · `Interceptions` · `Offsides` · `Passing Accuracy` · `Possession` · `Ppda Defensive Actions` · `Ppda Opppostition Passes` · `Red Cards` · `Second Yellow Card` · `Shots off Target` · `Shots on Target` · `Successful Crosses` · `Successful Dribbles` · `Successful Passes` · `Successful Tackles` · `Throw-ins` · `Total Passes` · `Total Shots` · `Touches in Opposition Box` · `Yellow Cards` · **`xG from Set Pieces`**

Trois observations qui comptent pour la suite :

1. **La liste dépasse largement les attentes.** Big chances, tirs bloqués, précision de passe, PPDA, duels, touchers dans la surface : ce sont des variables de modèle de haut niveau.
2. **Le fournisseur ne respecte pas ses propres libellés.** `Ppda Opppostition Passes` contient une faute de frappe (« Opppostition »). Un adaptateur qui reconnaîtrait les statistiques par leur libellé exact casserait au premier correctif du fournisseur. **La correspondance doit tolérer les fautes et les variantes.**
3. **Toutes les valeurs sont des chaînes** (`"62%"`, `"14"`, `"0.9"`), parfois avec unité, parfois avec virgule. Le parsing doit être explicite et testé, sans jamais convertir une absence en zéro.

**Preuve chiffrée du xG** (matchs réels) :
- match en direct : `Expected Goals (xG) — domicile 0.9 / extérieur 1.11`, `xG from Set Pieces — 0.07 / 0.21`
- match terminé : `Expected Goals (xG) — 1.66 / 2.99`, `xG from Set Pieces — 0 / 0.36`

**Ce que la statistique par mi-temps implique** : il n'existe **aucun** xG par mi-temps, ni aucun relevé figé à la pause. Le moteur de prédiction devra donc dériver les séries « 1re mi-temps / 2e mi-temps » à partir des **minutes des événements**, et non d'un agrégat fourni.

---

## 4. Couverture des compétitions — l'Afrique est là

Le catalogue compte **1 416 compétitions dans 159 pays**, dont :

**34 zones africaines · 128 compétitions**, notamment :

| Zone | Compétitions | Exemples |
|---|---|---|
| **Togo** | **1** | **National Championship** — `8t1t0tyumnnz6q87rvqqnnaw6` |
| Ghana | 5 | Premier League, Cup, Super Cup, League 1 (×2) |
| Nigeria | 4 | Premier League, FA Cup, National League, Women's Premier League |
| Côte d'Ivoire | 3 | League 1, League 2, National Cup |
| Sénégal | 4 | League 1, League 2, League Cup, National Cup |
| Cameroun | 4 | Elite League 1, Elite League 2, Cameroon Cup, Super Cup |
| Mali | 1 | Premier League |
| Burkina Faso | 3 | League 1, Ligue 2, Cup |
| Afrique du Sud | 10 | — |
| Maroc, Égypte, Algérie, Tunisie | 4 à 6 chacune | — |
| Continent (CAF) | 24 | Ligue des champions CAF, Coupe de la Confédération, Coupe d'Afrique des Nations, CAN féminine, COSAFA… |

**Le Togo est couvert** — c'est le point le plus important pour le public de SOLEIL. Mais avec une nuance majeure examinée en §5.

---

## 5. Qualité des données — ce qui marche, et ce qui ne marche pas

### 5.1 Mesures par compétition

| Compétition testée | Rencontres servies | Score final | **Score à la mi-temps** | Forme | Classement D/E |
|---|---|---|---|---|---|
| Premier League (Angleterre) — saison courante | 380 (50 joués) | ✅ 100 % des joués | ✅ **100 % des joués** | 100 % | 20 + 20 |
| Premier League (Angleterre) — saison 2025 | 510 (tous joués) | ✅ 100 % | ✅ **100 %** | — | — |
| Argentine Premier League | 495 (405 joués) | ✅ 100 % des joués | ✅ 100 % des joués | 100 % | 15 + 15 |
| **Ghana Premier League** — saison courante | 306 (35 joués) | 100 % des joués | ⚠️ **1 %** | 100 % | 18 + 18 |
| **Togo National Championship** — saison 2025/2026 | 182 (tous joués) | ✅ 100 % | ❌ **0 %** | 100 % | 14 + 14 |
| **Togo National Championship** — saison 2026/2027 | ❌ **0** | — | — | — | — |
| **Sénégal League 1** — saison courante | ❌ **0** | — | — | — | — |
| Journée du jour (monde) | 193 (4 en direct) | 86 % | 86 % | — | — |
| Journée du samedi 26/09 (monde) | 819 (802 joués) | 98 % | ⚠️ **54 %** | — | — |

### 5.2 Six faiblesses réelles, mesurées

1. **Le score à la mi-temps est très inégalement couvert.** Excellent dans les grands championnats (98-100 %), **absent au Togo (0 %)** et quasi absent au Ghana (1 %), alors que 182 rencontres complètes togolaises étaient pourtant disponibles. **Conséquence directe : la priorité P1 « score à la mi-temps » ne peut pas être satisfaite par ce fournisseur sur les compétitions africaines.** L'application devra afficher `Score à la mi-temps : indisponible` — et non un score reconstitué.
2. **Les saisons africaines en cours ne sont pas encore publiées.** Le Togo annonce la saison 2026/2027 dans sa liste mais la renvoie **vide** ; le Sénégal renvoie **0 rencontre**. Seul le Ghana est à jour. Un affichage « Matchs du jour » au Togo serait aujourd'hui vide.
3. **Le champ `form` est vide dans `/team_standings`** alors qu'il est rempli à 100 % dans `/league_standings`. Il faut donc **toujours passer par le classement de la compétition**, jamais par l'endpoint « équipe », pour la forme.
4. **Deux formats de statut coexistent** : les endpoints de matchs renvoient `status: { state: "postGame" }`, ceux d'équipe/compétition renvoient `status: "FT"`. Un adaptateur unique qui supposerait une seule forme échouerait silencieusement.
5. **Le pays est absent des calendriers** (`league.country` renseigné à 0 % dans `/league_fixtures`) : il doit être rattaché depuis `/leagues`, sinon chaque match perd sa provenance géographique.
6. **Le catalogue contient des doublons et des compétitions non pertinentes** (deux « League 1 » pour le Ghana, coupes départementales anglaises, équipes U18/U21, sections féminines). Une **liste blanche explicite** est indispensable : sans elle, le moteur mélangerait U21 et équipe première.

S'y ajoutent trois points d'attention opérationnels : les rencontres **reportées** (35) et **annulées** (3) apparaissent dans les listes futures et doivent être filtrées ; le `/h2h` s'appelle **par identifiant de match** et non par couple d'équipes ; la Premier League a **deux clubs nommés « Premier League »** selon le pays, un tri par nom sans le pays sélectionne la mauvaise compétition — erreur d'ailleurs commise puis corrigée pendant cet audit.

---

## 6. Coûts — mesurés, puis projetés

**Mesuré :** 1 crédit par appel, quelle que soit la quantité de données renvoyée. Un appel `/league_fixtures` a ramené **380 rencontres** pour 1 crédit ; un appel `/matches` a ramené **819 rencontres** pour 1 crédit.

**Coûts unitaires constatés :**

| Besoin | Coût réel |
|---|---|
| Toutes les rencontres du jour (monde entier) | **1 crédit** |
| Toutes les rencontres d'une date passée | **1 crédit** |
| Saison complète d'une compétition (calendrier + résultats) | **1 crédit** |
| Classement complet + domicile/extérieur + liste des saisons | **1 crédit** |
| Toutes les rencontres d'une équipe sur une saison | **1 crédit** |
| Statistiques + événements d'**un** match | **1 crédit** |
| Notification d'un but en direct (webhook) | **1 crédit par but**, inscription gratuite |

**Projection pour une première synchronisation raisonnable :**

| Étape | Calcul | Crédits |
|---|---|---|
| Catalogue des compétitions (une fois) | 1 | **1** |
| Structure + P1 pour 6 compétitions (Angleterre, Espagne, France, Italie, Allemagne, **Togo**) | 6 × (1 classement + 1 calendrier) | **12** |
| Rafraîchissement quotidien de ces 6 compétitions | 6 × 1 appel | **6 / jour** |
| Enrichissement xG/statistiques sur un échantillon mesurable | 200 matchs × 1 | **200** |
| **TOTAL de la première synchronisation** | | **≈ 220 crédits** |

**220 crédits sur 9 000 disponibles, soit 2,4 %.** Le pack équivalent coûterait 9,99 $ pour 50 000 crédits : même une fois les crédits offerts épuisés, l'exploitation annuelle de SOLEIL se compte en dizaines de dollars, pas en milliers.

**À l'inverse, ce qu'il ne faut PAS faire :** importer les 115 saisons de la Premier League. Rien que pour la saison courante, le détail match par match coûterait 380 crédits pour une seule compétition, et 1 900 crédits pour cinq — pour un bénéfice de modèle **non démontré**. La règle posée est claire : *une variable n'entre dans le modèle que si son gain est mesuré.* L'import d'historique lointain se fera donc **après** backtest, jamais avant.

---

## 7. Limites et conditions — état exact

| Élément | Constat |
|---|---|
| Débit autorisé | **2 req/s soutenues, pointe 5** (palier Starter). Paliers supérieurs : 5, 10, 15, 20, 40 req/s |
| Dépassement de débit | HTTP **429** + en-tête `Retry-After`. Ce n'est pas un problème de crédits |
| Crédits épuisés / quota du jour | HTTP **403** |
| Clé absente ou invalide | HTTP **401** — vérifié réellement |
| Paramètre invalide | HTTP **400** — vérifié réellement sur `/csb` |
| Expiration des crédits | **Jamais** (documenté et confirmé : solde inchangé sur des appels gratuits) |
| Usage commercial | Autorisé, sans attribution |
| Limite par seconde : par clé ou par IP ? | **NON DOCUMENTÉ — inconnu.** À ne pas supposer |
| Plusieurs comptes simultanés | **NON AUTORISÉ par les documents publics** |

### 7.1 Les 18 clés — position franche

**Vérifié :** les 18 clés sont valides, chacune sur un compte distinct, chacune créditée de **500 crédits**, soit **9 000 crédits** au total. La vérification n'a **rien coûté** : `GET /webhook/register` est gratuit, preuve en est que les soldes sont restés à 500.

Trois points doivent être dits clairement :

1. **Rien n'autorise l'usage simultané de plusieurs comptes.** Les documents publics ne l'évoquent pas ; le palier à 9,99 $ pour 50 000 crédits rend d'ailleurs la manœuvre inutile.
2. **La limite de débit est probablement le facteur bloquant, pas les crédits.** Même en supposant la rotation admise, 18 clés ne donneraient pas 36 req/s si le contrôle s'opère par adresse IP — et ce point n'est **pas documenté**. Personne ne peut l'affirmer sans le tester.
3. **Conséquence pratique :** le code **n'utilise qu'une seule clé à la fois** (rotation séquentielle en cas d'épuisement, jamais en parallèle). Le `KeyRing` sert à la continuité de service, pas à multiplier la capacité. **Aucun appel de cette sonde n'a sollicité une deuxième clé** : les 24 appels ont tous été émis avec la clé 1.

**Recommandation :** basculer sur une clé unique payante dès que le volume le justifiera, et conserver les 17 autres en réserve inactive.

---

## 8. Architecture recommandée

```
LiveFootballApi  (1 crédit/appel, 1 416 compétitions, 32 statistiques)
        │
        ├─ Adaptateur fournisseur ──────────────────────────────┐
        │    getCompetitions()      getMatchesByDate()           │
        │    getCompetitionFixtures()  getMatchDetails()         │
        │    getStandings()   getTeamMatches()   getH2H()        │
        │    ── jamais de forme brute hors de ce module ──       │
        │                                                        │
        ├─ Normalisation + validation ───────────────────────────┤
        │    · libellés de statistiques tolérants (fautes incluses)
        │    · deux formats de statut ramenés à un seul
        │    · pays rattaché depuis /leagues
        │    · absences conservées comme absentes, jamais 0       │
        │                                                        │
        ├─ Cache / TTL / déduplication / requête unique en vol ───┤
        │    · 20 utilisateurs sur un match = 1 seul appel        │
        │    · une donnée n'est jamais récupérée deux fois        │
        │                                                        │
        ├─ Base PostgreSQL ───────────────────────────────────────┤
        │    fournisseur · identifiant · horodatage · valeur
        │    saison · compétition · source · fraîcheur · qualité  │
        │                                                        │
        └─ Moteur de caractéristiques → moteur de prédiction
             (le moteur de prédiction ne voit jamais le format du fournisseur)
```

**Durées de fraîcheur retenues** (à ajuster par mesure, pas par intuition) :

| Donnée | TTL |
|---|---|
| Rencontres du jour | 60 s |
| Rencontres d'une date passée | 24 h (définitif) |
| Statistiques d'un match **en cours** | 60 s |
| Statistiques d'un match **terminé** | 24 h (définitif une fois le match clos) |
| Classement, calendrier de compétition | 1 h |
| Catalogue des compétitions | 24 h |

**Liste blanche de compétitions obligatoire**, avec pour chacune l'identifiant fournisseur, le pays, la saison courante et le drapeau « mi-temps disponible » (renseigné par mesure, pas supposé — c'est ce drapeau qui déclenchera l'affichage `indisponible`).

---

## 9. Données à intégrer en premier

| Ordre | Donnée | Priorité | Coût | Justification |
|---|---|---|---|---|
| 1 | **Liste blanche + classements** (points, joués, V/N/D, buts pour/contre, différence, forme, domicile/extérieur) | **P1** | 1/compétition | Socle du moteur, 100 % renseigné partout, mesuré au Togo comme au Ghana |
| 2 | **Résultats et calendriers par compétition** | **P1** | 1/compétition | Saison entière en un appel : 380 matchs pour 1 crédit |
| 3 | **Forme, domicile/extérieur, confrontations directes** | **P1** | 0 (inclus dans 1 et 2) | Déjà présents dans les réponses |
| 4 | **xG, xG sur coups de pied arrêtés** | **P2** | 1/match | Disponible — **mais uniquement sur les matchs que l'on analysera**, et après démonstration d'un gain de modèle |
| 5 | **Tirs, tirs cadrés, grosses occasions, possession, précision de passe** | **P2** | 0 (même appel que 4) | Arrivent avec le xG dans le même appel |
| 6 | **Corners, cartons, fautes, hors-jeu** | **P3** | 0 (même appel que 4) | Inclus |
| 7 | **Direct, compositions, blessures, arbitre** | **P4** | — | **Hors périmètre de cette phase** |

**Ce qui n'entre pas dans le modèle sans preuve :** les 32 statistiques ne seront pas toutes intégrées d'un coup. Chaque variable sera ajoutée, backtestée, mesurée contre le modèle actuel, et **conservée seulement si elle améliore réellement** le score. Une statistique disponible n'est pas une statistique utile.

---

## 10. Comparaison avec football-data.co.uk et TheSportsDB

**Non réalisée — volontairement.** La comparaison exige de disposer des deux jeux de données côte à côte ; or **aucun import n'a été effectué**, et la base locale est vide (voir §12). La réaliser maintenant exigerait d'ingérer d'abord, ce que la consigne interdit avant ce rapport.

**Protocole prévu pour l'étape suivante**, sur un petit échantillon : 5 compétitions × 30 rencontres récentes, comparaison terme à terme des équipes, dates, scores et compétitions ; mesure du taux de concordance, des écarts de date, des divergences de score et des équipes absentes d'un côté ou de l'autre. **Les deux sources existantes restent en place** : aucun retrait n'est décidé.

---

## 11. Ce que la sonde n'a PAS testé

Pour rester dans l'économie de crédits demandée, neuf endpoints documentés n'ont pas été appelés : `/lineups`, `/injuries`, `/officials`, `/referee`, `/team_squad`, `/team_search`, `/player`, `/player_matches`, `/player_search`. Aucune conclusion n'est tirée à leur sujet : ils sont **disponibles selon la documentation**, non vérifiés.

N'a pas été testé non plus : le comportement du webhook en conditions réelles (1 crédit par but), la cadence exacte de mise à jour du direct, et la limite de débit en charge (la sonde a respecté 700 ms entre appels et n'a jamais rencontré de 429).

---

## 12. Conclusion et décision

**Le fournisseur est bon — meilleur que ce que sa documentation laisse espérer.** 32 statistiques dont le xG et le xG sur coups de pied arrêtés, un classement avec domicile/extérieur, une saison entière pour un crédit, 115 saisons d'historique, une couverture africaine réelle incluant le Togo, et des logos exploitables pour les clubs, les compétitions et les joueurs.

**Trois réserves, mesurées et non négociables :**

1. **Le score à la mi-temps est absent des compétitions africaines** (0 % au Togo, 1 % au Ghana). Il devra être affiché comme indisponible là où il l'est.
2. **Les saisons africaines en cours ne sont pas publiées** (Togo et Sénégal renvoient zéro rencontre aujourd'hui). La fonction « Matchs du jour » sera vide au Togo tant que le fournisseur n'aura pas publié.
3. **Les drapeaux de pays ne sont pas fournis.** Les logos des clubs, des compétitions et des joueurs le sont.

**Décision proposée :** API Football Live devient la **source principale de statistiques et de classements**, football-data.co.uk et TheSportsDB restant en place pour la couverture historique et la redondance — le choix définitif étant pris **après** la comparaison sur échantillon du §10, jamais avant.

**Coût total de cet audit : 24 crédits.** Il reste **8 976 crédits** disponibles.

**La prochaine action n'est pas un import.** C'est la comparaison du §10 sur un échantillon réduit, dont dépendront le choix de source primaire et les variables retenues pour le modèle.
