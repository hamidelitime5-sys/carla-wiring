# Carla Wiring

**Préparez le patchbay de [Carla](https://kx.studio/Applications:Carla) sans le câbler à la main.**
Carla Wiring construit des chaînes de plugins (ampli, compresseur, réverbération…) à partir de **recettes de sons** (Jazz, Reggae, Funk, Clapton, Santana…),
applique les **presets et états** de vos plugins, et enregistre le tout en fichier `.carxp` que vous ouvrez dans Carla.
Il ne démarre **pas** le moteur audio et ne touche pas à votre carte son. Gratuit, hors ligne, sans abonnement.

> **English summary.** A free Windows tool (Tauri + Rust + TypeScript) that builds and exports [Carla](https://kx.studio/Applications:Carla) patchbay projects (`.carxp`):
> it scans your VST2/VST3 plugins, builds guitar signal chains from artist tone recipes with local rules (no paid AI required; optional free/local AI),
> applies plugin presets and captured plugin states directly inside the project file (formats verified byte-for-byte on real projects), and offers a visual
> patchbay editor and live scenes. The interface and docs are in French; contributions and translations are welcome.

## Ce que ça fait
- **Scanner vos plugins** (VST2/VST3, via `carla-discovery` de Carla), en ajoutant à votre base sans rien effacer ; ajout manuel d'un dossier ou d'un plugin.
- **Recettes de sons sans IA** : l'outil choisit, dans votre base, le plugin de chaque étape (rôle reconnu d'après le nom, corrigeable), propose un preset ou un son capturé, et câble en série (mono ↔ stéréo gérés).
- **Presets et états** : lit l'état réel d'un plugin dans un projet Carla (« sons capturés ») et le réécrit tel quel ; convertit certains fichiers de presets (TONE3000 `.t3kpreset`, Blue Cat's `.preset`) ; refuse les états tronqués.
- **Patchbay visuel** : câbles à la souris avec aimantation, sélection multiple, couleurs, alignement, zoom, annuler/rétablir, export centré dans le canevas de Carla.
- **Scènes de live** : variantes de câblage et de contournement, exportées en fichiers `.carxp` séparés.
- **Assistant IA facultatif** : Gemini (clé gratuite), Claude, ChatGPT ou **Ollama** (local, gratuit) ; son résultat est toujours vérifié avant d'être accepté.

## Ce que ça ne fait pas (honnêtement)
- Il ne règle pas l'intérieur d'un plugin : pour un plugin qui garde ses réglages en interne, la voie fiable est d'**enregistrer un projet dans Carla puis de le « capturer »**.
- Les recettes de sons sont des **synthèses de sources publiques** (voir `docs/NOTES-TECHNIQUES.md`), à régler à l'oreille ; le choix du micro, des cordes et la technique de jeu ne se règlent pas dans un plugin.
- Les formats de presets non vérifiés ne sont **pas** devinés : l'appli les refuse avec un message.

## Installation (Windows)
Prérequis : [Node.js](https://nodejs.org) (version LTS), [Rust](https://rustup.rs) et les « Outils de génération C++ » de Visual Studio. Windows 11 fournit déjà WebView2.

```
npm install
npm run tauri dev
```
Ou double-cliquez `LANCER.bat` (il vérifie les prérequis, installe les composants la première fois, puis lance l'appli).
La première compilation de Rust dure plusieurs minutes. Pour fabriquer un exécutable : `npm run tauri build`.

## Démarrage en 5 étapes
1. **Plugins** → « Chercher carla-discovery » (dans le dossier de Carla, à côté de `Carla.exe`) → « Scanner mes plugins ».
2. Vérifiez le **Rôle** reconnu pour chaque plugin (corrigez-le si besoin).
3. **Assistant** → « Recettes de sons » → choisissez un son → « Construire ».
4. **Patchbay** : ajustez à la souris ; **Enregistrer en .carxp**.
5. Ouvrez le fichier dans Carla.

## Tests et structure
- `npm test` (TypeScript ; les tests qui ont besoin de fichiers privés sont ignorés, voir `tests/FIXTURES.md`) et `cargo test --manifest-path crates/carla_core/Cargo.toml` (Rust).

| Dossier | Contenu |
|---|---|
| `src/` | Interface (TypeScript) : `main.ts`, bibliothèques `src/lib/` (lecture/écriture des `.carxp`, recettes, rôles, presets, états des plugins) |
| `crates/carla_core/` | Moteur Rust : scan des plugins, scan des presets, fichiers, appel des IA |
| `src-tauri/` | Enveloppe de l'application (commandes Tauri) |
| `docs/NOTES-TECHNIQUES.md` | Formats de fichiers décodés et comment chacun a été vérifié |
| `tests/` | Tests |

## Contribuer
Voir [`CONTRIBUTING.md`](CONTRIBUTING.md). Les recettes de sons (avec sources), les formats de presets (avec fichiers d'exemple libres de droits) et les retours d'utilisation sont les bienvenus.

## Licence et marques
MIT (voir `LICENSE`). Les noms de plugins et d'éditeurs cités appartiennent à leurs propriétaires ; le projet n'y est affilié en aucune façon.
