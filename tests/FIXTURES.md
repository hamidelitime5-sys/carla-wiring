# Fichiers de test privés

Une partie des tests (lecture de projets Carla `.carxp`, états de plugins, presets) s'appuie sur de **vrais fichiers**
rangés dans `tests/fixtures/`. Ce dossier n'est **pas publié** (voir `.gitignore`) : il contient des projets personnels
(noms d'utilisateur, chemins locaux), des états de plugins commerciaux et des modèles NAM/IR dont les licences appartiennent
à leurs auteurs.

Sans ces fichiers, `npm test` **ignore** les tests concernés (message « fichiers de test privés absents ») ; les autres
tests (rôles de plugins, recettes, fusion de la base, migration des réglages) tournent normalement.

## Fabriquer vos propres fichiers de test
Dans Carla, créez un projet avec un seul plugin, réglez-le, enregistrez-le en `.carxp`, puis copiez-le dans
`tests/fixtures/` sous les noms attendus par les tests (voir les `readFileSync('tests/fixtures/…')` en tête de chaque fichier).
Ne publiez jamais ces fichiers : ils contiennent des données personnelles ou protégées.
