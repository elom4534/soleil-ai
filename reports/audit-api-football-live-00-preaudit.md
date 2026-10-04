# Audit « API Football Live » — état des lieux AVANT import

**Date** 29 septembre 2026
**Fournisseur identifié** LiveFootballApi — `https://live-football-api.com/api/v1`
**Crédits consommés à ce stade : 0**
**Statut** audit partiel : tout ce qui est *vérifié* ci-dessous l'a été sans dépenser un crédit ; tout ce qui ne l'est pas est marqué comme tel.

> Principe directeur rappelé : **qualité > quantité · données réelles > données inventées · performance mesurée > promesses marketing**.
> Aucun chiffre de ce document n'est estimé sans être étiqueté « estimation ». Aucune statistique n'est supposée disponible.

---

## 1. Ce qui est établi sans avoir dépensé un seul crédit

### 1.1 Identité et cadre contractuel

| Élément | Valeur | Comment c'est établi |
|---|---|---|
| Service | LiveFootballApi | Documentation officielle |
| URL de base | `https://live-football-api.com/api/v1` | Documentation + appels de contrôle |
| Authentification | paramètre de requête `api_key` | Documentation + réponse 401 réelle |
| Facturation | **1 crédit par appel**, crédits **non expirants** | Documentation (tarifs) |
| Crédits offerts | 500 à l'ouverture du compte | Documentation (tarifs) |
| Palier payant d'entrée | 9,99 $ = 50 000 appels ; 39,99 $ = 300 000 | Documentation (tarifs) |
| Débit autorisé | 2 req/s soutenues, pointe 5 (palier Starter) ; jusqu'à 40 req/s selon palier | Documentation (tarifs) |
| Dépassement de débit | HTTP 429 + en-tête `Retry-After` | Documentation (erreurs) |
| Dépassement de crédits | HTTP 403 | Documentation (erreurs) |
| Usage commercial | autorisé, sans attribution | Documentation (FAQ) |
| Langues de réponse | `en`, `tr`, `de`, `ru` | Documentation |

### 1.2 Vérifications réseau réellement effectuées (0 crédit)

Une requête **sans clé** ne consomme rien : le fournisseur refuse avant décompte. Cela a permis de vérifier gratuitement que :

- l'hôte est joignable depuis cet environnement ;
- le format d'erreur annoncé est réel : `HTTP 401` → `{"success": false, "message": "API key is required."}` ;
- **les 13 chemins d'API existent réellement** (aucun 404) :

| Chemin testé | Réponse sans clé | Interprétation |
|---|---|---|
| `/matches` | 401 | existe, authentification requise |
| `/live_match_details` | 401 | existe, authentification requise |
| `/leagues` | 401 | existe, authentification requise |
| `/league_standings` | 401 | existe, authentification requise |
| `/league_fixtures` | 401 | existe, authentification requise |
| `/team_matches` | 401 | existe, authentification requise |
| `/team_standings` | 401 | existe, authentification requise |
| `/h2h` | 401 | existe, authentification requise |
| `/lineups` | 401 | existe, authentification requise |
| `/injuries` | 401 | existe, authentification requise |
| `/officials` | 401 | existe, authentification requise |
| `/player_search` | 401 | existe, authentification requise |
| `/csb` | 400 `« token and matchid parameters are required »` | existe ; les paramètres sont contrôlés **avant** l'authentification |

Conséquence pratique : le plan de sonde n'appellera aucun chemin inexistant. Un crédit gaspillé sur un 404 est écarté.

### 1.3 Structure de réponse (documentée)

```json
{ "success": true, "credits_remaining": 4999, "data": { … }, "timestamp": "2026-07-03 14:22:01" }
```

Deux points importants pour SOLEIL :

1. **Le solde de crédits est annoncé dans le corps** (`credits_remaining`), pas dans un en-tête HTTP. La sonde le relit après chaque appel : le coût réel est donc **vérifiable**, et pas seulement cru sur parole.
2. Les identifiants sont **opaques** (`lfa4phmwb3bhclg7aqht1ajcwk`, `lfa-premier-league`). Ils ne peuvent pas être devinés : ils doivent provenir d'une réponse. La sonde les collecte donc en cascade et les enregistre dans son rapport, pour que les synchronisations ultérieures n'aient pas à les redécouvrir (donc à repayer).

### 1.4 Table des endpoints (source : documentation officielle)

Statut : `✅ vérifié` = chemin confirmé par une réponse réelle · `📄 documenté` = décrit par le fournisseur, **non encore vérifié sur données réelles**.

| Endpoint | Méthode | Paramètres | Données renvoyées | Coût | Statut |
|---|---|---|---|---|---|
| `/matches` | GET | `date` (AAAA-MM-JJ, défaut aujourd'hui), `lang` | Rencontres du jour : id, compétition, journée, horaire, statut, équipes, **score**, **score à la mi-temps**, diffusion TV, tirs au but | 1 crédit | ✅ |
| `/live_match_details` | GET | `match_id`, `lang` | En-tête du match, **chronologie** (buts, cartons, remplacements), **statistiques**, URL CSB, stade, arbitre, chaînes TV, homme du match | 1 crédit | ✅ |
| `/leagues` | GET | `lang` | Compétitions groupées par pays | 1 crédit | ✅ |
| `/league_standings` | GET | `league_id`, `season`, `lang` | Classement (rang, joués, V/N/D, buts pour/contre, différence, points, **forme**, zone) + **classement domicile** et **classement extérieur** + **liste des saisons disponibles** | 1 crédit | ✅ |
| `/league_fixtures` | GET | `league_id`, `season`, `week`, `lang` | Calendrier complet par journée, scores des matchs joués, horaires des matchs à venir, mi-temps | 1 crédit | ✅ |
| `/team_matches` | GET | `team_id`, `season`, `lang` | Rencontres d'une équipe sur une saison (résultats et matchs à venir) + saisons disponibles | 1 crédit | ✅ |
| `/team_standings` | GET | `team_id`, `lang` | Position d'une équipe dans son/ses championnat(s) | 1 crédit | ✅ |
| `/h2h` | GET | `match_id`, `lang` | Confrontations directes, **forme récente des deux équipes**, synthèse V/N/D | 1 crédit | ✅ |
| `/lineups` | GET | `match_id`, `lang` | Onze de départ, remplaçants, entraîneur, **formation**, `is_projected` (≈1 h avant le coup d'envoi) | 1 crédit | 📄 |
| `/injuries` | GET | `match_id`, `lang` | Blessures et suspensions des deux effectifs | 1 crédit | 📄 |
| `/officials` | GET | `match_id` | Arbitre et officiels, avec moyennes de cartons de l'arbitre principal | 1 crédit | 📄 |
| `/referee` | GET | `referee_id` | Fiche arbitre : cartons, fautes, penaltys, historique | 1 crédit | 📄 |
| `/team_squad` | GET | `team_id`, `season` | Effectif complet + encadrement | 1 crédit | 📄 |
| `/team_search` | GET | `q` | Recherche d'équipes | 1 crédit | 📄 |
| `/player`, `/player_matches`, `/player_search` | GET | `player_id`, `team_id`, `season`, `q` | Profil joueur, carrière, matchs | 1 crédit | 📄 |
| `/csb` | GET | `token`, `matchid` | Tableau de bord visuel (iframe) | 1 crédit | ✅ (chemin + contrôle des paramètres) |
| `/webhook/register` | POST / GET / DELETE | `webhook_url`, `label`, `id` | Notification **à chaque but** d'un match en direct — inscription **gratuite**, **1 crédit par but notifié** | 0 crédit (inscription) / 1 crédit (but) | 📄 |

### 1.5 Ce que la documentation ne permet PAS d'affirmer

- **La liste exacte des statistiques de match n'est pas publiée.** La documentation cite « possession, tirs, corners, etc. » : cet « etc. » recouvre des enjeux majeurs (tirs cadrés, grosses occasions, passes, précision de passe, fautes, cartons, hors-jeu) et surtout **la présence ou l'absence d'expected goals**. Aucun document ne permet de trancher.
- **La profondeur d'historique par compétition n'est pas publiée.** Les réponses comportent un champ `available_seasons` : c'est lui qui fera foi.
- **Le nombre de compétitions africaines n'est pas publié.** La page commerciale annonce « 1 400+ ligues » et « 980+ ligues couvertes » selon les endroits — deux chiffres différents, aucune liste. L'audit des compétitions africaines (Togo, Ghana, Côte d'Ivoire, CAF…) est donc **décisif** pour SOLEIL et ne peut venir que du terrain.

### 1.6 Rotation de clés — position honnête

La tentation d'empiler plusieurs clés pour multiplier les quotas doit être écartée pour trois raisons vérifiables :

1. **Rien ne l'autorise** dans les documents publics : aucun texte n'évoque plusieurs comptes, plusieurs clés ou un usage multi-support. La règle posée par l'utilisateur est explicite : la rotation n'est admise que si le fournisseur et l'abonnement le permettent.
2. **Elle est probablement inutile** : la limitation invoquée (403 « daily limit exceeded ») protège un solde de crédits, et ces crédits sont achetables à bas coût et **non expirants** (9,99 $ pour 50 000 appels). Multiplier les comptes n'apporte aucune économie : cela ne fait que fragmenter la comptabilité et brouiller la traçabilité.
3. **Elle est risquée** : le débit autorisé (2 à 40 req/s selon palier) est contrôlé au niveau du compte ; un usage dispersé sur plusieurs clés complique la prévention du 429 et l'attribution d'un éventuel blocage.

**Conclusion : l'architecture de rotation existe dans le code (`KeyRing`) mais n'est pas activée comme moyen d'augmenter la capacité.** Elle ne sert qu'à la continuité de service en cas de clé révoquée ou régénérée. Aucune clé supplémentaire n'est requise.

---

## 2. Ce que la sonde de 14 crédits va établir

C'est la partie que **seules des réponses réelles** peuvent trancher. Plan exécutable : `npm run probe -- --budget 25` (14 crédits au maximum, 7 étapes indispensables, 7 conditionnelles qui s'annulent d'elles-mêmes si un identifiant manque).

| # | Appel | Question tranchée | Coût |
|---|---|---|---|
| 1 | `/leagues` | Authentification fonctionnelle ? Combien de pays, de compétitions ? **Lesquelles sont africaines ?** | 1 |
| 2 | `/matches?date=aujourd'hui` | Endpoint de la page « Matchs du jour » : volume, statuts, horaires, scores | 1 |
| 3 | `/matches?date=samedi dernier` | L'historique est-il servi, avec **score à la mi-temps** ? | 1 |
| 4 | `/matches?date=samedi prochain` | Le calendrier s'étend-il vers l'avant ? | 1 |
| 5 | `/live_match_details` (match du jour) | **Liste exhaustive des statistiques réellement fournies** — xG présent ou absent ? | 1 |
| 6 | `/live_match_details` (match terminé) | Les statistiques survivent-elles à la fin du match ? Condition de constitution de l'historique | 1 |
| 7 | `/league_standings` | Champs du classement, forme, classements domicile/extérieur, **saisons réellement disponibles** | 1 |
| 8 | `/league_fixtures` | Coût réel d'un import complet de compétition (1 appel = toute la saison ?) | 1 |
| 9 | `/league_fixtures?season=ancienne` | Une saison antérieure est-elle réellement servie ? | 1 |
| 10 | `/team_matches` | Rencontres d'équipe : forme, domicile/extérieur, buts pour/contre dérivables | 1 |
| 11 | `/team_standings` | Classement filtré par équipe | 1 |
| 12 | `/h2h` | Confrontations directes + forme récente des deux équipes | 1 |
| 13 | `/league_standings` (compétition africaine) | **Une compétition africaine a-t-elle un classement réel ?** | 1 |
| 14 | `/league_fixtures` (compétition africaine) | Une compétition africaine a-t-elle un calendrier réel ? | 1 |

Chaque réponse est archivée en JSON brut (`reports/probe-<horodatage>.json`) et en rapport lisible (`.md`). Le solde de crédits est relu après chaque appel et confronté au nombre d'appels émis : **le coût annoncé est vérifié, pas supposé**.

### Garde-fous embarqués dans la sonde

- plafond de crédits refusé avant tout appel si le plan dépasse le budget autorisé ;
- arrêt immédiat et conservation du solde en cas d'échec d'authentification, de quota ou de plafond ;
- aucune étape dépendant d'un identifiant indisponible n'est tentée ;
- 700 ms entre deux appels, pour rester sous les 2 req/s du palier et ne pas gaspiller un crédit en 429 ;
- aucune écriture dans les tables métier : la sonde n'écrit que la trace des appels (`ApiCallLog`) et le suivi par clé (`ApiCredential`).

---

## 3. Ce qui reste hors de portée de cette sonde

- `/lineups`, `/injuries`, `/officials`, `/referee`, `/team_squad`, `/player*` : documentés, non testés. Ils relèvent des priorités P3/P4 et n'ont pas à consommer de crédits maintenant.
- **Le direct** : la documentation décrit `is_live`, `state`, `minute`, la cadence de mise à jour et les webhooks « 1 crédit par but ». **Aucun moteur de direct ne sera développé dans cette phase**, conformément à la consigne.
- Le fournisseur ne publie **aucune donnée de modèle** (pas de probabilité, pas de prédiction toute faite). C'est cohérent avec SOLEIL : le moteur de prédiction reste le nôtre.

---

## 4. Correspondance avec les priorités de données de SOLEIL

| Priorité | Donnée attendue | Source chez ce fournisseur | Statut |
|---|---|---|---|
| **P1** | Historique de buts | `/matches` (journée par journée), `/league_fixtures` (saison entière) | à vérifier |
| **P1** | Score à la mi-temps | `/matches`, `/league_fixtures` (champ `halftime`) | à vérifier |
| **P1** | Forme (5 derniers) | `/league_standings` (champ `form`), `/h2h` (`home_form`/`away_form`) | à vérifier |
| **P1** | Domicile / extérieur | `/league_standings` (`home_standings`, `away_standings`), `/team_matches` | à vérifier |
| **P1** | Statistiques d'équipe | `/team_matches` (bilan dérivable), `/team_standings` | à vérifier |
| **P1** | Classements | `/league_standings` | à vérifier |
| **P2** | xG / xGA | **inconnu** — probablement **absent** (les statistiques sont des libellés texte) | étape 5 |
| **P2** | Tirs, tirs cadrés, grosses occasions, possession | `/live_match_details` → `stats[]` | étape 5 |
| **P3** | Corners, cartons, fautes, hors-jeu | `/live_match_details` → `stats[]` | étape 5 |
| **P4** | Direct, compos, blessures, arbitre | `/live_match_details`, `/lineups`, `/injuries`, `/officials` | documenté, non développé |

**Conséquence à anticiper :** si le xG est absent, l'application affichera `xG : indisponible`. Elle ne l'estimera pas, ne le simulera pas et ne le remplacera pas par un indicateur inventé — conformément à la règle posée.

---

## 5. Architecture retenue (et déjà en place)

```
LiveFootballApi (HTTP, 1 crédit/appel)
        ↓  adaptateur fournisseur        src/server/data/providers/apiFootballLive/*
        ↓  normalisation + validation    (formes internes, jamais la forme brute)
        ↓  base PostgreSQL               ApiCredential · ApiCallLog · modèles métier
        ↓  moteur de caractéristiques
        ↓  moteur de prédiction          (aucune dépendance à la forme du fournisseur)
```

- **Cache, TTL, déduplication, requête unique en vol** : 20 utilisateurs consultant le même match ne déclenchent qu'**un seul** appel. Une donnée donnée n'est jamais récupérée deux fois dans la fenêtre de fraîcheur.
- **Traçabilité** : fournisseur, identifiant fournisseur, horodatage, valeur, saison, compétition, source et fraîcheur sont conservés pour chaque donnée importante, avec un score de qualité.
- **Plafond de sécurité** : `SOLEIL_API_DAILY_BUDGET` vaut **0** par défaut. Aucun appel ne peut partir sans autorisation explicite.
- **Sources existantes conservées** : football-data.co.uk et TheSportsDB restent en place. La comparaison prévue (équipes, matchs, scores, dates, compétitions) se fera sur un petit échantillon, une fois les données du nouveau fournisseur rapatriées.

---

## 6. Coûts — faits et estimations

**Faits (documentation) :** 1 crédit par appel, crédits non expirants, 500 crédits offerts, 9,99 $ les 50 000, 39,99 $ les 300 000.

**Estimations**, à confirmer par les étapes 2 et 8 de la sonde (le nombre réel de rencontres par journée et par saison n'est pas connu avant mesure) :

| Besoin | Consommation estimée |
|---|---|
| Programmer « Matchs du jour » (toutes compétitions confondues) | **1 crédit par jour**, quel que soit le nombre de rencontres |
| Suivre une compétition toute une saison (classement + calendrier) | 2 crédits par jour |
| Détail d'un match (statistiques + événements) | 1 crédit par match |
| Séries d'une équipe | 1 crédit par équipe et par jour |

Exemple d'ordre de grandeur, **à valider** : 5 compétitions suivies + 50 matchs détaillés par jour ≈ 55 crédits par jour, soit ≈ 1 650 par mois. Le pack à 9,99 $ (50 000 crédits) couvrirait alors plus de deux ans. Ce chiffre est une projection, pas une mesure : la sonde donnera les volumes réels.

---

## 7. Décision demandée

1. **Transmettre la clé** (ou l'écrire directement dans `soleil/.env`, ligne `API_FOOTBALL_LIVE_KEYS="…"`).
2. **Confirmer la dépense de 14 crédits** pour l'audit complet (plafond annoncé : 25, marge incluse). Sur les 500 crédits offerts, l'audit représente moins de 3 %.
3. Ensuite seulement : rapport §22 définitif, comparaison avec les sources existantes, puis décision d'import.

**Tant que ces trois points ne sont pas réglés, aucune donnée n'est importée et aucun crédit n'est consommé.**

---

## 8. État de l'environnement (transparence)

L'environnement d'exécution a été reconstruit depuis l'instantané : Node 22, les dépendances et la base PostgreSQL locale ont dû être remontés. Après remontage, **la base locale est vide** — les 4 676 matchs, 252 équipes et 667 prédictions de la phase précédente sont perdus (la base locale de développement ne survit pas à une reconstruction du conteneur).

Ce point **ne concerne pas le fournisseur audité** et ne bloque pas l'audit : la sonde n'écrit aucune donnée métier. Il sera traité après l'audit, en réimportant depuis football-data.co.uk et TheSportsDB — sources gratuites, **0 crédit LiveFootballApi** — puis en republiant les prédictions avec le moteur inchangé.

---

## Annexe — ce qui a été corrigé dans la sonde avant tout appel

Trois défauts réels ont été trouvés et corrigés **avant** de dépenser le premier crédit (19 tests de lecture des réponses, exécutés sur les charges utiles publiées par le fournisseur) :

1. **Détection du xG** : la première version ne cherchait le xG que dans les *noms de champs*. Or chez ce fournisseur une statistique arrive sous la forme `{ "label": "Expected Goals", "home": "1.84", "away": "0.71" }` : la clé est toujours `label`. La sonde aurait donc conclu « xG absent » **même si le xG était fourni** — l'erreur exacte que l'audit doit rendre impossible. La détection porte désormais sur les libellés **et** sur les valeurs, avec preuve chiffrée à l'appui.
2. **Échantillonnage des listes** : seuls les deux premiers éléments d'une liste étaient examinés ; une statistique en fin de liste passait inaperçue. L'échantillon est porté à douze.
3. **Date d'une journée** : la date vit dans l'enveloppe de la réponse, pas dans chaque rencontre ; sans ce repli, la sonde n'aurait pas su dire quelle journée elle avait interrogée.
