# Contribuer à Carla Wiring

Merci de votre intérêt ! Le projet est jeune et son auteur n'est pas informaticien de métier : les contributions, les retours
d'utilisation et les rapports de bogues précis sont très précieux.

## Avant de commencer
- Lisez le `README.md` (ce que fait l'outil) et `docs/NOTES-TECHNIQUES.md` (formats de fichiers déjà décodés, et **comment chaque point a été vérifié**).
- Principe du projet : **ne rien présumer**. Un format de fichier de plugin (état, preset) n'est géré que s'il a été vérifié sur de vrais fichiers ;
  sinon l'appli refuse avec un message clair plutôt que d'écrire un projet cassé.

## Mettre en place l'environnement (Windows)
1. Node.js (version LTS), Rust (rustup) et les « Outils de génération C++ » de Visual Studio.
2. `npm install` puis `npm run tauri dev` (ou `LANCER.bat`).
3. Tests : `npm test` (TypeScript) et `cargo test --manifest-path crates/carla_core/Cargo.toml` (Rust).

## Règles de contribution
- **Un test par comportement.** Toute correction de bogue ajoute le test qui l'aurait détecté.
- **Rust de production : pas de `unwrap()`, `expect()`, `panic!`** (une erreur doit devenir un message pour l'utilisateur).
- **Pas de fichiers privés** dans les propositions : ni projets `.carxp` personnels, ni presets ou modèles protégés, ni clés d'API, ni chemins contenant un nom d'utilisateur. Pour un test, fabriquez un fichier minimal.
- Messages et textes de l'interface en **français**, simples et sans jargon (public : musiciens débutants en informatique).
- Dites ce que vous avez **vérifié** et ce que vous n'avez **pas pu vérifier** dans votre proposition (voir le modèle de demande de fusion).

## Idées bienvenues
- Recettes de sons supplémentaires (basse, clavier…) **avec leurs sources**.
- Lecture d'autres formats de presets ou d'états de plugins (avec des fichiers d'exemple libres de droits).
- Traductions, accessibilité, corrections de l'interface.

## Marques et licences
Les noms de plugins et d'éditeurs cités (Native Instruments, Blue Cat Audio, MeldaProduction, Positive Grid, TONE3000, HeadRush…) appartiennent à leurs propriétaires ; le projet n'y est pas affilié. Les recettes de sons sont des synthèses de sources publiques, à titre indicatif.
