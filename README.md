# cartographie-entrepot

Cartographie 3D interactive des emplacements de l'entrepôt B&M.

- **Site en ligne** : voir GitHub Pages (Settings → Pages) une fois activé sur ce dépôt.
- **Source des données** : export SAP BI `emplacement_depot.xlsx`, déposé sur `\\WH-APP-WMS\usr_prio_encours$`.
- **Mise à jour** : `scripts/build_data.py` régénère `emplacements.txt` + `meta.json` à partir du fichier source. Un job planifié l'exécute automatiquement plusieurs fois par jour et pousse le résultat ici.
- **Fichiers statiques** (`index.html`, `app.js`, `three.min.js`, `OrbitControls.js`) : changent rarement, uniquement lors d'une évolution du logiciel.
