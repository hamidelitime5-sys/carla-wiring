#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scan_plugins.py : scanne vos plugins (VST2, VST3, JSFX facultatif) avec l'outil de Carla
"carla-discovery" et ecrit plugins_db.json, a importer dans l'appli Patchbay.

Utilisation (aucune installation, Python 3 seulement) :
    python scan_plugins.py
    python scan_plugins.py --discovery "C:\\Program Files\\Carla\\carla-discovery-win64.exe"
    python scan_plugins.py --vst3 "D:\\MesVST3" --vst2 "D:\\MesVST2" --out plugins_db.json

Principe : pour chaque plugin on lance  carla-discovery-win64.exe <type> <chemin>
puis on lit les lignes "carla-discovery::cle::valeur".
Les plugins 32 bits ou qui plantent sont listes dans "errors" avec la raison.
"""

import argparse
import datetime
import glob
import json
import os
import shutil
import subprocess
import sys

DEFAUT_VST3 = [r"C:\Program Files\Common Files\VST3"]
DEFAUT_VST2 = [r"C:\Program Files\VstPlugins", r"C:\Program Files\Steinberg\VstPlugins",
               r"C:\Program Files\Common Files\VST2"]
NOM_DISCOVERY = ["carla-discovery-win64.exe", "carla-discovery-native.exe", "carla-discovery-native"]
CHEMINS_CARLA = [r"C:\Program Files\Carla", r"C:\Program Files (x86)\Carla", r"C:\Program Files\KXStudio\Carla",
                 r"C:\Carla", r"C:\Program Files\falkTX\Carla"]
PLUGIN_IS_SYNTH = 0x004   # indice 'hints' de Carla : instrument


# ----------------------------------------------------------------------------------------------
# Lecture de la sortie de carla-discovery

def parse_discovery(texte):
    """Retourne (liste de blocs plugin, liste de messages d'erreur)."""
    blocs, erreurs, courant = [], [], None
    for ligne in texte.splitlines():
        ligne = ligne.strip()
        if not ligne.startswith("carla-discovery::"):
            continue
        reste = ligne[len("carla-discovery::"):]
        if "::" not in reste:
            continue
        cle, valeur = reste.split("::", 1)
        if cle == "init":
            courant = {}
        elif cle == "end":
            if courant is not None:
                blocs.append(courant)
            courant = None
        elif cle == "error":
            erreurs.append(valeur)
        elif cle == "warning":
            pass
        elif courant is not None:
            courant[cle] = valeur
    return blocs, erreurs


def entier(valeur, defaut=0):
    try:
        return int(str(valeur).strip())
    except (TypeError, ValueError):
        return defaut


def bloc_vers_plugin(bloc, type_plugin, chemin):
    hints = entier(bloc.get("hints"))
    categorie = bloc.get("category", "").strip()
    return {
        "type": type_plugin,
        "name": bloc.get("name", "").strip() or os.path.splitext(os.path.basename(chemin))[0],
        "label": bloc.get("label", "").strip(),
        "maker": bloc.get("maker", "").strip(),
        "path": chemin,
        "uniqueId": entier(bloc.get("uniqueId")) if bloc.get("uniqueId") else None,
        "category": categorie,
        "hints": hints,
        "isSynth": categorie.lower() == "synth" or bool(hints & PLUGIN_IS_SYNTH),
        "audioIns": entier(bloc.get("audio.ins")),
        "audioOuts": entier(bloc.get("audio.outs")),
        "cvIns": entier(bloc.get("cv.ins")),
        "cvOuts": entier(bloc.get("cv.outs")),
        "midiIns": entier(bloc.get("midi.ins")),
        "midiOuts": entier(bloc.get("midi.outs")),
        "parameterIns": entier(bloc.get("parameters.ins")),
        "parameterOuts": entier(bloc.get("parameters.outs")),
    }


# ----------------------------------------------------------------------------------------------
# Recherche des fichiers

def trouver_discovery(indique):
    if indique:
        return indique if os.path.isfile(indique) else None
    for nom in NOM_DISCOVERY:
        trouve = shutil.which(nom)
        if trouve:
            return trouve
    for dossier in CHEMINS_CARLA:
        for nom in NOM_DISCOVERY:
            c = os.path.join(dossier, nom)
            if os.path.isfile(c):
                return c
    for racine in (r"C:\Program Files", r"C:\Program Files (x86)"):
        for c in glob.glob(os.path.join(racine, "*", "carla-discovery-win64.exe")):
            return c
        for c in glob.glob(os.path.join(racine, "*", "*", "carla-discovery-win64.exe")):
            return c
    # version "portable" decompressee dans Telechargements ou sur le Bureau (ex. Carla-2.5.10-win64)
    for dossier in ("Downloads", "Desktop", "Documents"):
        base = os.path.join(os.path.expanduser("~"), dossier)
        for nom in NOM_DISCOVERY:
            trouves = glob.glob(os.path.join(base, "Carla*", "**", nom), recursive=True)
            if trouves:
                return trouves[0]
    return None


def lister_vst3(dossiers):
    """Les .vst3 peuvent etre des fichiers ou des dossiers (bundles) : on ne descend pas dedans."""
    resultats = []
    for dossier in dossiers:
        if not os.path.isdir(dossier):
            continue
        for racine, sous_dossiers, fichiers in os.walk(dossier):
            for nom in list(sous_dossiers):
                if nom.lower().endswith(".vst3"):
                    resultats.append(os.path.join(racine, nom))
                    sous_dossiers.remove(nom)
            for nom in fichiers:
                if nom.lower().endswith(".vst3"):
                    resultats.append(os.path.join(racine, nom))
    return sorted(set(resultats), key=str.lower)


def lister_vst2(dossiers):
    resultats = []
    for dossier in dossiers:
        if not os.path.isdir(dossier):
            continue
        for racine, _, fichiers in os.walk(dossier):
            for nom in fichiers:
                if nom.lower().endswith(".dll"):
                    resultats.append(os.path.join(racine, nom))
    return sorted(set(resultats), key=str.lower)


def lister_jsfx(dossiers):
    resultats = []
    for dossier in dossiers:
        if not os.path.isdir(dossier):
            continue
        for racine, _, fichiers in os.walk(dossier):
            for nom in fichiers:
                if nom.lower().endswith(".jsfx") or os.path.splitext(nom)[1] == "":
                    resultats.append(os.path.join(racine, nom))
    return sorted(set(resultats), key=str.lower)


# ----------------------------------------------------------------------------------------------
# Scan

def scanner_un(discovery, type_plugin, chemin, delai, discovery32=None):
    """Retourne (liste de plugins, message d'erreur ou None).
    Si l'outil 64 bits echoue et que carla-discovery-win32.exe existe, on reessaie en 32 bits."""
    plugins, erreur = scanner_une_fois(discovery, type_plugin, chemin, delai)
    if erreur and discovery32 and type_plugin != "VST3":
        plugins32, erreur32 = scanner_une_fois(discovery32, type_plugin, chemin, delai)
        if not erreur32:
            for pl in plugins32:
                pl["bits"] = 32
            return plugins32, None
    return plugins, erreur


def scanner_une_fois(discovery, type_plugin, chemin, delai):
    try:
        res = subprocess.run([discovery, type_plugin.lower(), chemin], capture_output=True,
                             timeout=delai, text=True, errors="replace")
    except subprocess.TimeoutExpired:
        return [], "delai depasse (%d s) : le plugin ne repond pas" % delai
    except OSError as e:
        return [], "impossible de lancer carla-discovery : %s" % e

    blocs, erreurs = parse_discovery(res.stdout)
    if not blocs:
        if erreurs:
            return [], "; ".join(erreurs)
        if res.returncode != 0:
            return [], "carla-discovery a plante (code %d), probablement un plugin 32 bits ou un fichier qui n'est pas un plugin" % res.returncode
        return [], "aucun plugin trouve dans ce fichier"
    resultat = [bloc_vers_plugin(b, type_plugin.upper(), chemin) for b in blocs]
    for pl in resultat:
        pl["bits"] = 64
    return resultat, None


def main():
    p = argparse.ArgumentParser(description="Scanne vos plugins avec carla-discovery et ecrit plugins_db.json")
    p.add_argument("--discovery", help="chemin de carla-discovery-native.exe (ou -win64.exe)")
    p.add_argument("--vst3", action="append", help="dossier VST3 (peut etre repete)")
    p.add_argument("--vst2", action="append", help="dossier VST2 (peut etre repete)")
    p.add_argument("--jsfx", action="append", help="dossier JSFX (facultatif)")
    p.add_argument("--out", default="plugins_db.json", help="fichier de sortie")
    p.add_argument("--delai", type=int, default=60, help="delai maximum par plugin, en secondes")
    a = p.parse_args()

    discovery = trouver_discovery(a.discovery)
    if not discovery:
        print("[!] carla-discovery introuvable (carla-discovery-native.exe ou carla-discovery-win64.exe).")
        print("    Il se trouve dans le dossier de Carla, a cote de Carla.exe.")
        print('    Relancez avec :  python scan_plugins.py --discovery "CHEMIN\\carla-discovery-native.exe"')
        sys.exit(1)
    print("[*] carla-discovery :", discovery)
    discovery32 = os.path.join(os.path.dirname(discovery), "carla-discovery-win32.exe")
    if not os.path.isfile(discovery32):
        discovery32 = None
    print("[*] carla-discovery 32 bits :", discovery32 or "absent (les plugins 32 bits seront en echec)")

    vst3 = a.vst3 or DEFAUT_VST3
    vst2 = a.vst2 or DEFAUT_VST2
    jsfx = a.jsfx or []
    fichiers = ([("VST3", c) for c in lister_vst3(vst3)] +
                [("VST2", c) for c in lister_vst2(vst2)] +
                [("JSFX", c) for c in lister_jsfx(jsfx)])
    print("[*] %d fichier(s) a scanner" % len(fichiers))
    if not fichiers:
        print("[!] Aucun fichier trouve. Indiquez vos dossiers avec --vst3 et --vst2.")
        sys.exit(1)

    plugins, erreurs = [], []
    for i, (type_plugin, chemin) in enumerate(fichiers, 1):
        trouves, erreur = scanner_un(discovery, type_plugin, chemin, a.delai, discovery32)
        if erreur:
            erreurs.append({"type": type_plugin, "path": chemin, "reason": erreur})
            print("  [%d/%d] ECHEC %s : %s" % (i, len(fichiers), os.path.basename(chemin), erreur))
        else:
            plugins.extend(trouves)
            print("  [%d/%d] OK    %s (%d plugin(s))" % (i, len(fichiers), os.path.basename(chemin), len(trouves)))

    sortie = {
        "format": "carla-patchbay-plugins-db",
        "version": 1,
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "discovery": discovery,
        "folders": {"vst3": vst3, "vst2": vst2, "jsfx": jsfx},
        "count": len(plugins),
        "plugins": plugins,
        "errors": erreurs,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(sortie, f, ensure_ascii=False, indent=2)
    print()
    print("[OK] %d plugin(s) ecrits dans %s ; %d fichier(s) en echec" % (len(plugins), a.out, len(erreurs)))
    print("     Importez ce fichier dans l'appli avec 'Importer ma base de plugins'.")


if __name__ == "__main__":
    main()
