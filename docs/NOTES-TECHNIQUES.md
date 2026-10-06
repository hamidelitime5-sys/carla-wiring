# Notes techniques

> Notes rédigées pendant le développement. Les fichiers de test mentionnés (projets Carla, presets) sont **privés** et ne sont pas publiés ;
> chaque constat de format y est suivi de la manière dont il a été vérifié. Voir `tests/FIXTURES.md`.

# Carla Wiring

Outil de **préparation** pour le patchbay de Carla (Windows 11, Tauri + Rust + TypeScript).

Vous décrivez ce que vous voulez jouer ; **l'assistant IA construit une chaîne complète, bien câblée, avec vos propres plugins** ; vous la voyez et la corrigez à la souris ; vous l'exportez en `.carxp` pour l'ouvrir dans Carla. L'outil ne démarre pas le moteur audio et ne touche pas à votre carte son.

## Les quatre fonctions

1. **Plugins** : scanne votre bibliothèque VST2/VST3 avec l'outil de Carla (`carla-discovery`) : ports audio/MIDI et identifiants exacts. C'est la base sur laquelle s'appuie l'assistant.
2. **Assistant** : « Guitare lead saturé en live, compresseur, EQ, limiteur… » → l'IA (Claude, ChatGPT ou Gemini, au choix) propose une chaîne **uniquement avec des plugins de votre base**. Le programme **vérifie** tout : plugin réellement présent, ports existants, câbles audio/MIDI compatibles, chemin jusqu'à la sortie. En cas de faute, l'IA reçoit la liste précise des erreurs et corrige (3 essais maximum). Elle donne aussi des conseils de réglage et dit ce qui manque dans votre base.
3. **Patchbay** : la chaîne est dessinée ; corrigez à la souris : clic sur deux ports = câble ; glisser l'en-tête = déplacer ; double-clic sur un câble (ou clic puis Suppr) = supprimer ; ⏻ = contourner un plugin ; × = supprimer une boîte ; barre d'outils pour ajouter un plugin de la base, les nœuds de la carte son et le MIDI. Votre travail est mémorisé automatiquement. « Enregistrer en .carxp » puis « Ouvrir dans Carla ».

4. **Reprendre l'existant** : « Ouvrir un .carxp » charge un projet Carla dans le Patchbay. À l'enregistrement, **vos plugins, leurs réglages sauvegardés et le reste du fichier ressortent identiques octet pour octet** (testé sur `un projet réel.carxp`) : seul le câblage change (et le contournement d'un plugin, qui écrit `Active=No`). L'assistant peut alors **modifier** cette chaîne (« ajoute un limiteur ») au lieu d'en refaire une : case « Modifier la chaîne actuelle » (les plugins du projet doivent être dans votre base).

Pour le live :
- **Scènes** : plusieurs états du même rig (plugins contournés, câblage) : son clair, saturé, solo… Enregistrez-les d'un clic, rappelez-les, et **exportez chaque scène en fichier `.carxp` séparé** (`monrig_Clair.carxp`, `monrig_Solo.carxp`) à ouvrir dans Carla selon le morceau. L'IA peut proposer des variantes (par contournement des plugins existants, vérifiées avant ajout). Une scène contourne un plugin : un effet contourné laisse passer le signal, un instrument contourné ne sonne plus.
- **Remplacer un plugin** (bouton ⇄ sur la boîte) : choisissez d'abord le nouveau dans « Ajouter un plugin… », puis cliquez ⇄ : les câbles compatibles sont gardés, ceux dont le port n'existe plus sont listés. **Les réglages sauvegardés de l'ancien plugin ne sont pas transférés.**
- **Rig multi-instruments** : une demande du type « guitare, clavier et Ketron vers un mixeur » (exemple « Rig complet » dans l'Assistant) est acceptée : chaque source a sa sous-chaîne et son port MIDI, plusieurs sorties peuvent être reliées à la même entrée (Carla les additionne).

**Découverte automatique des presets, plugin par plugin** (onglet Presets → « Découvrir automatiquement ») : pour chacun de vos plugins, l'outil cherche les dossiers qui lui correspondent dans les emplacements habituels (AppData, ProgramData, Documents, dossiers VST) et liste les formats de fichiers qu'ils contiennent, classés en **probables presets** (vert), **à vérifier** (jaune : ajoutés seulement si vous le décidez) et **bruit** (gris : positions de fenêtres, images, journaux…). Un clic ajoute le dossier et ses formats probables à la liste de scan. C'est prévu pour de nouvelles familles de plugins dont le format est inconnu à l'avance, par exemple **MeldaProduction** : d'après leur forum, leurs données sont dans `AppData\Roaming\MeldaProduction\<plugin>\` (avec des fichiers `.winstate` qui ne sont pas des presets) ; je n'ai pas pu confirmer l'extension de leurs presets, la découverte la révèle chez vous. Les noms de dossiers « MeldaProduction MXXX » ou « BC Axiom VST3 data » sont rattachés aux plugins `MXXX` et `Blue Cat's Axiom`. Pour n'importe quel plugin, le **son capturé** (ci-dessous) fonctionne quel que soit son format de presets.

**Guitar Rig et autres contenus de Native Instruments** : leurs presets (`.ngrr`) sont dans `C:\Program Files\Common Files\Native Instruments\Guitar Rig 7\Rack Presets`, pas dans AppData. La découverte parcourt aussi `Program Files` et `Program Files (x86)` (donc `Common Files`). Les formats `.ngrr` (Guitar Rig), `.nksf` (Native Instruments), `.h2p` (u-he), `.vital` (Vital) et `.ffp` (FabFilter) sont reconnus comme presets. Ces formats sont propres à leur éditeur : l'assistant **propose** le nom du preset (une demande en français comme « lead saturé » retrouve « Super Crunch » ou « Stoney Fuzz » grâce à des synonymes français-anglais), mais vous le chargez dans le plugin ; pour une application automatique, utilisez les *sons capturés*.

**Comment Carla enregistre un preset (constaté sur un projet réel, un fichier de test privé (non publié))** : pas de nom ni de chemin de preset, mais l'**état complet du plugin** dans la balise `<Chunk>`. Pour Blue Cat's (VST3) : `VC2!` + longueur + XML `<VST3PluginState><IComponent>…` où les données sont encodées en « base64 JUCE » ; une fois décodées, on lit le document `<Preset progName="…" currentPresetFilePath="Factory Presets/…/….preset">` avec tous les réglages. Conséquences, toutes testées sur ce projet :
- *Sons capturés* : le nom réel du preset choisi dans Carla et son dossier d'origine sont lus dans l'état (ex. « Modu Smooth Delay », famille « Guitar - Clean + FX »), et l'assistant les voit.
- Le codec (décoder puis ré-encoder) redonne **exactement les mêmes octets** que Carla pour les trois plugins Blue Cat's du projet, et un plugin généré de zéro avec son état est **identique, bloc pour bloc**, à celui de Carla.
- *Presets `.preset` de Blue Cat's* : option **expérimentale** (Presets → « Appliquer automatiquement… », désactivée par défaut). Le fichier est lu et son document `<Preset>` enveloppé comme le fait Carla. Hypothèse non encore vérifiée avec un vrai fichier : qu'un `.preset` contienne le même document `<Preset>` que l'état (à confirmer avec un fichier de `…\BC … data\Factory Presets`). Si le fichier a un autre format, il est refusé avec un message et le preset reste « à charger à la main ».
- Les noms de dossiers de Blue Cat's comme « BC Dynamics 4 VST3(Stereo) data » sont rattachés au plugin « Blue Cat's Dynamics 4(Stereo) » (la mention VST3 est ignorée où qu'elle soit ; Stereo, Mono et Dual restent distincts).

**Les « sons capturés » fonctionnent avec tous les plugins VST3** (vérifié sur un vrai projet un fichier de test privé (non publié)) : Carla enveloppe l'état de **chaque** plugin VST3 de la même façon (`VC2!` + `VST3PluginState`). Pour BIAS FX 2, MeldaProduction (MCabinetMB) et ReValver 5, un plugin régénéré de zéro avec son état capturé est **identique, octet pour octet, au bloc écrit par Carla** (y compris les balises `CurrentProgramIndex` / `CurrentProgramName` de Melda, désormais rejouées). Le **nom du preset** est lu quand le plugin le permet : BIAS FX 2 (JSON, clé `currentPresetName`, ex. « American Dream »), MeldaProduction (état compressé zlib, clé `CurrentPresetID` « Catégorie~Nom », ex. « Medium~Timely fork »), Blue Cat's (document `<Preset>`). ReValver 5 stocke un bloc binaire opaque : le son se capture et se rejoue, mais son nom n'est pas lisible (donnez-lui un nom au moment de la capture, le champ est modifiable). Le décompresseur zlib est écrit en TypeScript pur (aucune dépendance) et vérifié contre la bibliothèque zlib de Node.

**TONE3000 (plugin NAM/IR officiel, gratuit, un fichier de test privé (non publié))** : son état est un arbre binaire « T3KB » dont chaque bloc de la chaîne embarque le **JSON complet de la capture du catalogue** (titre, type d'appareil `amp-cab` / `outboard` / `space`, tags, fabricant) : l'appli en tire le nom du son capturé (ex. « Marshall Bluesbreaker + Neve 1073LB + The Green-Wood Cemetery Catacombs ») et des mots-clés de recherche (ex. `clapton`, `blues`) qui aident l'assistant à le retrouver. L'état **embarque aussi les modèles** : un son capturé est autonome (il s'ouvre sur une autre machine) mais pèse environ 2 Mo ; l'appli affiche la taille et prévient quand la bibliothèque devient lourde. Le plugin ne lit que les captures NAM de génération **A2** : les anciens `.nam` sont refusés (garder l'ancien lecteur NAM pour eux). Dans Carla, le programme est appliqué **avant** l'état (« Part 2 - set program » puis « Part 6 - set chunk » dans CarlaPlugin.cpp) : l'état l'emporte.

**Presets TONE3000 (`.t3kpreset`) appliqués automatiquement** : chaque preset enregistré dans le plugin est un fichier du dossier `%APPDATA%\TONE3000\Presets`. Format vérifié sur un vrai preset (un fichier de test privé (non publié)) et le vrai projet Carla correspondant : `T3KH` + en-tête + arbre `T3KPreset` (ChainSnapshot, Params) en arbre binaire JUCE (lecteur/écrivain dans `valuetree.ts`, relire puis réécrire redonne les mêmes octets). La `ChainSnapshot` (blocs, réglages, **modèles NAM/IR embarqués**) est **identique octet pour octet** à celle de l'état enregistré par Carla ; il suffit donc de la placer dans l'état TONE3000 (gabarit extrait de un projet réel : réglages de la machine, routage MIDI, queue JUCE) avec les 36 paramètres du preset. **Preuve** (`tests/t3k.test.ts`) : preset + gabarit redonnent exactement l'état de 1,3 Mo et le `<Chunk>` du projet. Avec la case « Appliquer automatiquement » (Presets), l'appli lit le `.t3kpreset` choisi pour un plugin TONE3000 et l'écrit dans le `.carxp` ; les fichiers d'une autre version du format (schemaVersion ≠ 1, paramètre inconnu) sont refusés avec un message. Les fichiers du dossier Presets sont rattachés au plugin automatiquement (le dossier s'appelle « TONE3000 »).

**Plugins mono (ReValver 5) : son des deux côtés** — un plugin qui n'expose qu'**une** sortie audio (`output_1`) ne donne du son que d'un côté s'il n'est relié qu'à une des deux entrées de sa destination. Constaté sur un vrai projet (un fichier de test privé (non publié)) : la bonne solution est de relier cette unique sortie **aux deux** côtés de la carte son (`Audio Output:Left` et `Audio Output:Right`). L'appli le fait automatiquement pour les chaînes de l'assistant, avertit dans le Patchbay (« n'a qu'une sortie audio (mono)… reste muette ») et propose le bouton **« Mono → stéréo »**. Seules les deux premières entrées de la destination sont alimentées : les entrées suivantes (chaîne latérale) ne sont jamais touchées, et rien n'est modifié si l'autre côté reçoit déjà un autre signal.

**Fichiers produits par une IA (état tronqué)** : un modèle de langage ne peut pas écrire à la main l'état binaire d'un plugin (463 Ko pour BIAS FX 2). Constaté sur deux fichiers générés par l'IA de Google (un fichier de test privé (non publié)) : l'état annonce 347 252 octets mais n'en contient que 1,3 ou 2,9 Ko (le reste est coupé, balises de fin absentes, parfois base64 invalide), sans câbles ni positions. L'appli **vérifie maintenant l'intégrité** de chaque état au format `VC2!` : à l'ouverture d'un projet elle prévient (« l'état enregistré de … est abîmé… le plugin repartira de ses réglages d'usine »), et « Capturer » refuse un état tronqué avec la raison. Tous les états réellement enregistrés par Carla (Blue Cat's, Melda, BIAS FX 2, ReValver, TONE3000) passent la vérification.

**Stratégie sans frais (sans IA)** — l'assistant IA ne peut choisir que parmi les plugins de la base : si elle est petite, il invente des identifiants (« p5 », « p6 »…) qui n'existent pas, d'où les erreurs en rouge. Trois corrections :
- **Scan de plugins** : un scan **ajoute** désormais à la base (option « Ajouter à ma base », cochée) au lieu de la remplacer ; boutons « Ajouter un dossier VST3/VST2 », « Ajouter un plugin précis (fichier) » et « Ajouter les emplacements habituels » ; une entrée de liste peut aussi être un `.vst3` / `.dll` précis. Un **bundle VST3** (dossier `X.vst3`, ex. TONE3000) est remplacé par son fichier intérieur `Contents\x86_64-win\X.vst3`, c'est-à-dire le chemin que Carla enregistre dans ses projets. « Vider la base » demande une confirmation.
- **Recettes de sons** (Assistant) : Jazz (Benson), Reggae (général, Anderson, Marvin rythmique et solo), Funk (Rodgers), Clapton, Santana (« Europa »), Police (Summers). Chaque recette est une suite d'étapes (rôles) ; le constructeur choisit dans VOTRE base le plugin de chaque étape (rôle reconnu d'après le nom, corrigeable dans l'onglet Plugins, puis mots préférés, puis présence d'un preset ou son capturé adapté), propose un preset/son capturé s'il y en a, câble en série de la carte son à la carte son (mono ↔ stéréo gérés), et signale ce qui manque sans jamais l'inventer. Un plugin tout-en-un (Guitar Rig, BIAS, ReValver, TONE3000, Axiom) tient lieu d'ampli quand la base n'en a pas ; baffle et boost sont alors « déjà inclus ». Instantané (3000 plugins : quelques ms), gratuit, sans clé.
- **Si l'IA échoue**, le message indique les identifiants valides (« de p1 à pN »), avertit quand la base est trop petite, et sélectionne la recette la plus proche de la demande.

**Composants (enceintes, micros, réverbs…)** : un plugin comme Guitar Rig 7 a un dossier `Content` avec un sous-dossier par composant (Cabinet IR Loader, Matched Cabinet Pro, Control Room Pro, Reflektor, Tapedeck, Vintage Verb…). « Analyser un dossier » détaille maintenant **chaque sous-dossier** (nombre de fichiers et formats trouvés) pour choisir lesquels scanner, sans présumer de leur contenu. Chaque preset garde sa **famille** (le composant d'où il vient, ex. `[Reflektor]`), transmise à l'assistant et au Patchbay ; une demande comme « enceinte 4x12 », « micro » ou « ressort » favorise les presets de la famille correspondante (synonymes français-anglais). Le choix de l'enceinte reste à l'intérieur de Guitar Rig : l'assistant propose le preset, vous le chargez dans le plugin.

**Presets** (onglet Presets) :
- *Presets sur le disque* : scan de dossiers précis (recommandé) ou d'un disque entier (long, arrêtable, dossiers système ignorés, raccourcis non suivis) à la recherche de `.fxp`, `.fxb`, `.vstpreset`, `.preset` (extensions modifiables ; « Analyser un dossier » liste les extensions qu'il contient pour découvrir le format d'un plugin). Les `.fxp`/`.fxb` sont associés à leur plugin par l'identifiant lu **dans le fichier** ; les autres par le nom de leur dossier. L'index est mémorisé dans le dossier de données de l'application (pas besoin de rescanner à chaque démarrage).
- *Sons capturés* : l'état complet d'un plugin lu dans un projet que **Carla** a enregistré. Il est réinjecté tel quel dans le `.carxp` exporté : c'est le seul moyen **sûr** d'appliquer un réglage automatiquement. Réglez le plugin dans Carla, enregistrez, puis « Capturer depuis un projet .carxp ».
- L'assistant reçoit la liste des presets réellement trouvés pour les plugins du catalogue (les plus pertinents pour la demande) et peut en proposer **un par plugin** ; le programme refuse un preset inventé ou appartenant à un autre plugin. Un *son capturé* est appliqué automatiquement ; un *fichier* est affiché, noté dans la fiche, et reste à charger dans le plugin (le format interne de Carla n'est pas celui de ces fichiers : je ne le fabrique pas, par sécurité). Vous pouvez aussi choisir un preset à la main dans le panneau de sélection du Patchbay.

**Patchbay : outils** — tirer un câble en glissant d'un port à un autre (ou clic sur deux ports) : le fil est souple et **s'aimante** sur le port compatible le plus proche, ou sur la boîte où vous relâchez ; sélection multiple (en-tête, Maj+clic, cadre, Ctrl+A) et déplacement groupé ; Suppr ; couleur par boîte (propre à cet outil : Carla ne la conserve pas) ; alignement, répartition, aimantation à la grille ; zoom (− / + / Ctrl+molette) et « Centrer la vue ».

**Disposition dans Carla** — Carla place au centre de son canevas (3100 × 2400) toute boîte sans position. À l'enregistrement, l'outil écrit maintenant la position de **toutes** les boîtes (plugins **et** carte son), décalées pour que l'ensemble soit centré sur ce point, avec la disposition que vous avez dessinée. Case « Centrer dans Carla à l'enregistrement » (activée par défaut). Si l'affichage vous paraît encore trop étalé, resserrez les boîtes dans le Patchbay avant d'enregistrer.

Et aussi : **Annuler / Rétablir** (boutons ou Ctrl+Z / Ctrl+Y) ; **Mes chaînes** (enregistrer, charger, dupliquer, supprimer, échanger par fichier : un nom déjà utilisé remplace la chaîne) ; **Vérifier les plugins** (signale un fichier déplacé ou désinstallé, à faire la veille d'un concert) ; **Fiche (.md)** (plugins dans l'ordre du signal, câbles, conseils, fichiers : un aide-mémoire).

## Clés API et quotas

- **Claude** : un abonnement Pro/Max **ne contient pas** d'accès API (confirmé par le support d'Anthropic). Créez un compte Console (`console.anthropic.com`), achetez des crédits prépayés, puis Settings → API Keys → Create key (la clé `sk-ant-…` n'est affichée qu'une fois). L'arrêt de votre abonnement n'affecte pas cette clé.
- **Gemini** : clé gratuite sur `aistudio.google.com/apikey` (niveau gratuit avec limites par minute et par jour, susceptibles de changer). **ChatGPT** : clé sur `platform.openai.com`, avec crédits.
- **Une clé et un modèle par fournisseur** ; vous choisissez un fournisseur principal et, si vous voulez, un **fournisseur de secours**.
- **Limite par minute atteinte** : l'application attend le délai demandé par le fournisseur et réessaie toute seule (2 fois au plus). **Quota du jour épuisé** : elle ne fait pas attendre pour rien ; elle bascule sur le fournisseur de secours s'il a une clé, sinon elle l'explique.
- Une demande = 1 à 3 appels. Le compteur d'appels du jour (dans les réglages de l'IA) compte ce que cette application envoie ; il ne connaît pas votre quota réel.
- Les clés sont enregistrées **en clair** sur cet ordinateur : ne les partagez pas.

## Ollama : une IA gratuite sur votre PC (hors ligne)

1. Installez Ollama : `ollama.com/download/windows` (il tourne ensuite en arrière-plan).
2. Téléchargez un modèle dans un terminal, par exemple `ollama pull qwen2.5:7b` (autres noms possibles : `llama3.2:3b`, `mistral`, `gemma2`…). Le nom doit être exact.
3. Dans l'application : Assistant → Fournisseur « Ollama » → le nom du modèle. Aucune clé, aucun quota, rien ne sort de l'ordinateur.

**Si c'est trop lent** : le temps vient surtout de la lecture de la liste de vos plugins par le modèle. Réglez « Plugins envoyés au modèle » (100 par défaut ; essayez 60) : l'application garde les plus pertinents pour votre demande. Un modèle plus petit (`qwen2.5:3b`, `llama3.2:3b`) va plus vite mais se trompe davantage. Pour voir si Ollama travaille : `ollama ps` dans un terminal (colonne PROCESSOR : CPU ou GPU) et le Gestionnaire des tâches. L'application affiche le temps écoulé et la durée de chaque réponse.

Points d'attention : c'est votre PC qui calcule (mémoire à peu près égale à la taille du modèle téléchargé, réponses plus lentes, surtout la première) ; la licence de chaque modèle est à vérifier ; un petit modèle local se trompe plus souvent qu'un grand modèle en ligne (le programme vérifie tout et renvoie les erreurs au modèle, 3 essais, mais il y aura plus d'échecs). Ollama utilise par défaut une fenêtre de contexte de 4096 jetons, trop petite pour votre catalogue : l'application demande elle-même un contexte plus grand (réglable, 16384 par défaut), l'agrandit si la demande l'exige et **n'envoie que les plugins les plus pertinents** si la base est trop grosse pour ce contexte. Ollama peut aussi servir de fournisseur de secours quand un quota en ligne est atteint.

## Installation (une seule fois)

1. **Node.js** (LTS) : https://nodejs.org
2. **Rust** : https://rustup.rs (installation par défaut ; utilise votre Visual Studio 2022 « Développement Desktop en C++ »)
3. WebView2 : déjà présent dans Windows 11.
4. Une **clé API** chez le fournisseur d'IA de votre choix (son quota et ses tarifs s'appliquent).

## Lancer

**Le plus simple : double-cliquez sur `LANCER.bat`** (dans ce dossier). Il vérifie que Node.js et Rust sont installés, installe les composants la première fois, puis ouvre l'application. Gardez sa fenêtre ouverte tant que vous utilisez l'application.

Ou à la main :

Dans une invite de commandes, dans ce dossier :

```
npm install
npm run tauri dev
```

La première compilation de Rust dure plusieurs minutes. Pour fabriquer l'exécutable : `npm run tauri build`.

## Premier usage

1. **Plugins** → « Chercher carla-discovery » (ou « Parcourir » : `carla-discovery-native.exe`, dans le dossier de Carla à côté de `Carla.exe`, par exemple dans le dossier où vous avez extrait Carla) → « Scanner mes plugins ».
2. **Assistant** → fournisseur + clé API ; vérifiez les noms de ports de votre carte son (copiez-les depuis le Patchbay de Carla, ou « Ports depuis un projet .carxp ») → décrivez votre besoin → « Créer la chaîne avec l'IA ».
3. **Patchbay** → ajustez → « Enregistrer en .carxp » → « Ouvrir dans Carla ».

## Architecture

| Dossier | Rôle |
|---|---|
| `crates/carla_core` | Moteur Rust **testé** (32 tests) : appel de l'IA (Claude / ChatGPT / Gemini, erreurs traduites : clé refusée, quota…), scan des plugins (délai, secours 32 bits), fichiers, lancement de Carla |
| `src-tauri` | Couche Tauri fine (compilée et vérifiée) : expose ces fonctions à l'interface |
| `src/lib/chain.ts` | Cerveau de l'assistant : catalogue, consignes, **validation** de la réponse de l'IA, boucle de correction |
| `src/lib/editor.ts`, `patchbay.ts` | Opérations et vue interactive du patchbay |
| `src/lib/presets.ts`, `store.ts` | Presets (association aux plugins, sons capturés) et enregistrement des données volumineuses |
| `crates/carla_core/src/presets.rs` | Scan des presets (en-têtes .fxp/.fxb/.vstpreset, arrêt, protections) |
| `src/lib/importer.ts` | Ouverture d'un `.carxp` existant (blocs de plugins conservés tels quels) |
| `src/lib/library.ts`, `history.ts`, `sheet.ts`, `scenes.ts` | Mes chaînes, annuler/rétablir, fiche de concert, scènes |
| `src/lib/carxp.ts` | Lecture / écriture / validation du format `.carxp` (testé sur un vrai projet Carla) |
| `src/lib/matrix.ts` | Générateur de câblage 32 sorties (modes stéréo / une pour une / vers mixeur), **non branché à l'interface** pour l'instant, testé, réutilisable |
| `tools/scan_plugins.py` | Scanner autonome en Python (secours) |

**Règle Rust** : aucun `unwrap()`, `expect()`, `panic!()` ni accès par indice en code de production (interdits par `deny(clippy::…)`) ; toutes les fonctions renvoient `Result<T, String>` ; une panique dans une tâche est convertie en erreur lisible. L'appel IA utilise le magasin de certificats de Windows (compatible avec les antivirus qui inspectent le HTTPS). La clé API n'est jamais écrite dans un message d'erreur.

## Ce qui est vérifié, et ce qui ne l'est pas

Vérifié automatiquement : format `.carxp` sur votre `un projet réel.carxp` ; validation de l'IA (plugin inventé, mauvais port, audio vers MIDI, rien à la sortie, JSON cassé) et boucle de correction ; opérations du patchbay ; interface (parcours complet sous jsdom, IA simulée) ; appel IA contre un faux serveur pour les trois fournisseurs ; **un essai réel contre l'API de Claude avec une fausse clé, qui renvoie bien « clé refusée (401) »** (connexion sécurisée, format de requête et message d'erreur confirmés) ; compilation de la couche Tauri (Linux).

**À valider chez vous** :
- l'ouverture d'un projet Carla réel (le format a été vérifié sur un seul projet, `un projet réel.carxp`) : si l'un de des projets réels s'ouvre mal, envoyez-le-moi ;
- une **vraie réponse d'un modèle** : les noms de modèles par défaut (`claude-sonnet-4-6`, `gpt-4o`, `gemini-3.8-flash`) sont modifiables et peuvent devenir périmés (cas déjà arrivé : Google refuse alors avec une erreur 404 qui indique le nom à utiliser) dans l'interface ; si le fournisseur répond « modèle introuvable », changez-le. La qualité musicale des chaînes ne peut pas être jugée par le programme ;
- le scan avec votre vrai `carla-discovery` ;
- l'ouverture d'un `.carxp` généré dans Carla ;
- le code propre à Windows (6 lignes qui masquent la fenêtre console des programmes lancés) n'a pas pu être compilé ici ;
- un type de plugin JSFX n'est pas vérifié dans le format `.carxp`.
