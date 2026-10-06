//! Scan de la bibliothèque de plugins avec l'outil de Carla (`carla-discovery`).
//!
//! Pour chaque plugin : `carla-discovery-native.exe <type> <chemin>` puis lecture des lignes
//! `carla-discovery::clé::valeur`. Les plugins 32 bits sont rescannés avec `carla-discovery-win32.exe`.
use crate::proc::no_window;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const PLUGIN_IS_SYNTH: u32 = 0x004;
const DISCOVERY_NAMES: [&str; 3] = ["carla-discovery-native.exe", "carla-discovery-win64.exe", "carla-discovery-native"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbPlugin {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub label: String,
    pub maker: String,
    pub path: String,
    pub unique_id: Option<u64>,
    pub category: String,
    pub hints: u32,
    pub is_synth: bool,
    pub audio_ins: u32,
    pub audio_outs: u32,
    pub cv_ins: u32,
    pub cv_outs: u32,
    pub midi_ins: u32,
    pub midi_outs: u32,
    pub parameter_ins: u32,
    pub parameter_outs: u32,
    pub bits: u8,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub plugins: Vec<DbPlugin>,
    pub errors: Vec<ScanError>,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

type Block = HashMap<String, String>;

/// Analyse la sortie texte de carla-discovery : (blocs plugin, messages d'erreur).
pub fn parse_discovery(text: &str) -> (Vec<Block>, Vec<String>) {
    let mut blocks: Vec<Block> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut current: Option<Block> = None;
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("carla-discovery::") else { continue };
        let Some((key, value)) = rest.split_once("::") else { continue };
        match key {
            "init" => current = Some(Block::new()),
            "end" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
            }
            "error" => errors.push(value.to_string()),
            _ => {
                if let Some(b) = current.as_mut() {
                    b.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    (blocks, errors)
}

fn num(b: &Block, key: &str) -> u32 {
    b.get(key).and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(0)
}

fn text(b: &Block, key: &str) -> String {
    b.get(key).map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn block_to_plugin(b: &Block, kind: &str, path: &Path, bits: u8) -> DbPlugin {
    let hints = num(b, "hints");
    let category = text(b, "category");
    let fallback = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = text(b, "name");
    DbPlugin {
        kind: kind.to_uppercase(),
        name: if name.is_empty() { fallback } else { name },
        label: text(b, "label"),
        maker: text(b, "maker"),
        path: path.to_string_lossy().into_owned(),
        unique_id: b.get("uniqueId").and_then(|v| v.trim().parse::<u64>().ok()),
        is_synth: category.eq_ignore_ascii_case("synth") || (hints & PLUGIN_IS_SYNTH) != 0,
        category,
        hints,
        audio_ins: num(b, "audio.ins"),
        audio_outs: num(b, "audio.outs"),
        cv_ins: num(b, "cv.ins"),
        cv_outs: num(b, "cv.outs"),
        midi_ins: num(b, "midi.ins"),
        midi_outs: num(b, "midi.outs"),
        parameter_ins: num(b, "parameters.ins"),
        parameter_outs: num(b, "parameters.outs"),
        bits,
    }
}

/// Lance carla-discovery sur un fichier, avec délai maximum. Renvoie les plugins trouvés ou une raison lisible.
pub fn run_discovery(exe: &Path, kind: &str, file: &Path, timeout: Duration, bits: u8) -> Result<Vec<DbPlugin>, String> {
    let mut cmd = Command::new(exe);
    cmd.arg(kind.to_lowercase()).arg(file).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Impossible de lancer carla-discovery : {e}"))?;
    let mut stdout = child.stdout.take().ok_or_else(|| "Sortie de carla-discovery inaccessible.".to_string())?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("délai dépassé ({} s) : le plugin ne répond pas", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("Erreur d'attente de carla-discovery : {e}")),
        }
    };
    let bytes = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let output = String::from_utf8_lossy(&bytes).into_owned();
    let (blocks, errors) = parse_discovery(&output);
    if blocks.is_empty() {
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        if !status.success() {
            return Err("carla-discovery a planté : plugin 32 bits, ou fichier qui n'est pas un plugin".to_string());
        }
        return Err("aucun plugin trouvé dans ce fichier".to_string());
    }
    Ok(blocks.iter().map(|b| block_to_plugin(b, kind, file, bits)).collect())
}

/// Pour un bundle VST3 (dossier « X.vst3 »), renvoie le fichier binaire qu'il contient
/// (`Contents/x86_64-win/X.vst3`) : c'est ce chemin que Carla enregistre dans ses projets. Sinon, renvoie le chemin tel quel.
pub fn vst3_binary(bundle: &Path) -> PathBuf {
    if !bundle.is_dir() {
        return bundle.to_path_buf();
    }
    let dir = bundle.join("Contents").join("x86_64-win");
    if let Some(name) = bundle.file_name() {
        let exact = dir.join(name);
        if exact.is_file() {
            return exact;
        }
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut found: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && ext_of(p) == "vst3").collect();
        found.sort();
        if let Some(first) = found.into_iter().next() {
            return first;
        }
    }
    bundle.to_path_buf()
}

/// Plugins `.vst3` : les entrées peuvent être des DOSSIERS à parcourir (sous-dossiers compris) ou un plugin précis
/// (fichier `.vst3` ou dossier-bundle `.vst3`, ajouté à la main). Un bundle est remplacé par son fichier binaire intérieur.
pub fn list_vst3(folders: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for f in folders {
        let p = Path::new(f.trim());
        if ext_of(p) == "vst3" && (p.is_file() || p.is_dir()) {
            out.push(p.to_path_buf());
            continue;
        }
        walk(p, &mut out, 0, &|p, is_dir| {
            let ext = ext_of(p);
            (ext == "vst3", is_dir && ext == "vst3")
        });
    }
    finish(out.into_iter().map(|p| vst3_binary(&p)).collect())
}

/// Plugins VST2 : dossiers à parcourir, ou fichier `.dll` précis ajouté à la main.
pub fn list_vst2(folders: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for f in folders {
        let p = Path::new(f.trim());
        if p.is_file() && ext_of(p) == "dll" {
            out.push(p.to_path_buf());
            continue;
        }
        walk(p, &mut out, 0, &|p, is_dir| (!is_dir && ext_of(p) == "dll", false));
    }
    finish(out)
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn finish(mut v: Vec<PathBuf>) -> Vec<PathBuf> {
    v.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    v.dedup();
    v
}

/// `matcher(chemin, est_dossier)` renvoie (garder, ne_pas_descendre).
fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize, matcher: &dyn Fn(&Path, bool) -> (bool, bool)) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let is_dir = p.is_dir();
        let (keep, stop) = matcher(&p, is_dir);
        if keep {
            out.push(p.clone());
        }
        if is_dir && !stop {
            walk(&p, out, depth + 1, matcher);
        }
    }
}

/// Cherche carla-discovery dans les emplacements habituels (Program Files, Téléchargements, Bureau, Documents).
pub fn find_discovery() -> Option<PathBuf> {
    let mut bases: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files\Carla"),
        PathBuf::from(r"C:\Program Files (x86)\Carla"),
        PathBuf::from(r"C:\Program Files\KXStudio\Carla"),
    ];
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if let Some(h) = home {
        for sub in ["Downloads", "Desktop", "Documents", "Téléchargements", "Bureau"] {
            let base = h.join(sub);
            if let Ok(rd) = std::fs::read_dir(&base) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().to_lowercase().starts_with("carla") {
                        bases.push(e.path());
                    }
                }
            }
        }
    }
    bases.iter().find_map(|b| find_named(b, 0))
}

fn find_named(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 4 {
        return None;
    }
    for name in DISCOVERY_NAMES {
        let c = dir.join(name);
        if c.is_file() {
            return Some(c);
        }
    }
    let rd = std::fs::read_dir(dir).ok()?;
    rd.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_named(&e.path(), depth + 1))
}

/// Scan complet. `progress` est appelé après chaque fichier (pour la barre de progression).
pub fn scan_all(
    discovery: &Path,
    vst3_dirs: &[String],
    vst2_dirs: &[String],
    timeout: Duration,
    progress: &mut dyn FnMut(Progress),
) -> Result<ScanReport, String> {
    if !discovery.is_file() {
        return Err(format!("carla-discovery introuvable : {}", discovery.display()));
    }
    let discovery32 = discovery.parent().map(|p| p.join("carla-discovery-win32.exe")).filter(|p| p.is_file());
    let mut files: Vec<(&str, PathBuf)> = Vec::new();
    files.extend(list_vst3(vst3_dirs).into_iter().map(|p| ("VST3", p)));
    files.extend(list_vst2(vst2_dirs).into_iter().map(|p| ("VST2", p)));
    let total = files.len();
    let mut report = ScanReport { plugins: Vec::new(), errors: Vec::new(), total_files: total };
    for (i, (kind, path)) in files.iter().enumerate() {
        let mut result = run_discovery(discovery, kind, path, timeout, 64);
        if result.is_err() && *kind != "VST3" {
            if let Some(d32) = &discovery32 {
                if let Ok(found) = run_discovery(d32, kind, path, timeout, 32) {
                    result = Ok(found);
                }
            }
        }
        match result {
            Ok(mut found) => report.plugins.append(&mut found),
            Err(reason) => report.errors.push(ScanError { kind: kind.to_string(), path: path.to_string_lossy().into_owned(), reason }),
        }
        progress(Progress { done: i + 1, total, current: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "\ncarla-discovery::init::------------\ncarla-discovery::build::5\ncarla-discovery::hints::4\ncarla-discovery::category::other\ncarla-discovery::name::Gros Synthe\ncarla-discovery::maker::Moi\ncarla-discovery::label::gs\ncarla-discovery::uniqueId::1282364005\ncarla-discovery::audio.ins::0\ncarla-discovery::audio.outs::32\ncarla-discovery::midi.ins::1\ncarla-discovery::midi.outs::0\ncarla-discovery::end::------------\ncarla-discovery::error::Quelque chose\n";

    #[test]
    fn parse_un_bloc_et_une_erreur() {
        let (blocks, errors) = parse_discovery(OUT);
        assert_eq!(blocks.len(), 1);
        assert_eq!(errors, vec!["Quelque chose".to_string()]);
        let p = block_to_plugin(&blocks[0], "vst2", Path::new("C:/x/gs.dll"), 64);
        assert_eq!((p.kind.as_str(), p.name.as_str(), p.audio_outs, p.midi_ins), ("VST2", "Gros Synthe", 32, 1));
        assert_eq!(p.unique_id, Some(1282364005));
        assert!(p.is_synth, "hints & 4 => instrument");
    }

    #[test]
    fn json_compatible_avec_le_front() {
        let (blocks, _) = parse_discovery(OUT);
        let p = block_to_plugin(&blocks[0], "vst2", Path::new("gs.dll"), 32);
        let v = serde_json::to_value(&p).unwrap_or_default();
        assert_eq!(v["type"], "VST2");
        assert_eq!(v["audioOuts"], 32);
        assert_eq!(v["isSynth"], true);
        assert_eq!(v["uniqueId"], 1282364005u64);
        let back: DbPlugin = serde_json::from_value(v).unwrap_or_else(|_| p.clone());
        assert_eq!(back, p);
    }

    #[test]
    fn ignore_le_bruit_et_les_lignes_incompletes() {
        let (b, e) = parse_discovery("bonjour\ncarla-discovery::name\ncarla-discovery::name::sans_init\n");
        assert!(b.is_empty() && e.is_empty());
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn faux_outil(dir: &Path, nom: &str, corps: &str) -> PathBuf {
            let p = dir.join(nom);
            let _ = std::fs::write(&p, format!("#!/bin/sh\n{corps}\n"));
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
            p
        }

        fn dossier_temp(nom: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("carla_core_{nom}_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            let _ = std::fs::create_dir_all(&d);
            d
        }

        #[test]
        fn scan_complet_avec_secours_32_bits_et_delai() {
            let d = dossier_temp("scan");
            let v2 = d.join("vst2");
            let v3 = d.join("vst3/Marque/Axiom.vst3");
            let _ = std::fs::create_dir_all(&v2);
            let _ = std::fs::create_dir_all(&v3);
            for f in ["bon.dll", "vieux32.dll", "helper.dll", "lent.dll"] {
                let _ = std::fs::write(v2.join(f), b"x");
            }
            let bloc = "printf '\\ncarla-discovery::init::---\\ncarla-discovery::name::%s\\ncarla-discovery::audio.outs::2\\ncarla-discovery::end::---\\n' \"$NOM\"";
            let native = faux_outil(&d, "carla-discovery-native.exe", &format!(
                "case \"$2\" in *bon.dll) NOM=Bon; {bloc};; *Axiom.vst3) NOM=Axiom; {bloc};; *helper.dll) printf '\\ncarla-discovery::error::Pas un plugin\\n';; *lent.dll) sleep 5;; *) exit 3;; esac"));
            let _ = faux_outil(&d, "carla-discovery-win32.exe", &format!("case \"$2\" in *vieux32.dll) NOM=Vieux; {bloc};; *) exit 3;; esac"));
            let mut etapes = 0;
            let rapport = scan_all(&native, &[d.join("vst3").to_string_lossy().into_owned()], &[v2.to_string_lossy().into_owned()],
                Duration::from_millis(700), &mut |_p| etapes += 1);
            let rapport = rapport.unwrap_or(ScanReport { plugins: vec![], errors: vec![], total_files: 0 });
            assert_eq!(rapport.total_files, 5);
            assert_eq!(etapes, 5);
            let mut noms: Vec<_> = rapport.plugins.iter().map(|p| (p.name.clone(), p.bits)).collect();
            noms.sort();
            assert_eq!(noms, vec![("Axiom".to_string(), 64), ("Bon".to_string(), 64), ("Vieux".to_string(), 32)]);
            assert_eq!(rapport.errors.len(), 2);
            assert!(rapport.errors.iter().any(|e| e.reason.contains("Pas un plugin")));
            assert!(rapport.errors.iter().any(|e| e.reason.contains("délai dépassé")));
            let _ = std::fs::remove_dir_all(&d);
        }

        #[test]
        fn outil_introuvable_est_une_erreur_propre() {
            let r = scan_all(Path::new("/n/existe/pas"), &[], &[], Duration::from_secs(1), &mut |_| {});
            assert!(r.is_err());
        }
    }

    #[cfg(test)]
    mod liste_des_plugins {
        use super::*;

        fn arbre(nom: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("carla_scan_{nom}_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            let _ = std::fs::create_dir_all(&d);
            d
        }
        fn touche(p: &Path) {
            if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
            let _ = std::fs::write(p, b"x");
        }

        #[test]
        fn bundle_vst3_remplace_par_son_fichier_binaire_comme_dans_carla() {
            let d = arbre("bundle");
            touche(&d.join("VST3/TONE3000.vst3/Contents/x86_64-win/TONE3000.vst3"));
            touche(&d.join("VST3/TONE3000.vst3/Contents/Resources/lisezmoi.txt"));
            touche(&d.join("VST3/Blue Cat's/BC Axiom VST3.vst3"));
            touche(&d.join("VST3/Autre.vst3/Contents/x86_64-win/nom_different.vst3"));
            touche(&d.join("VST3/Vide.vst3/Contents/Resources/x.txt"));
            let v = list_vst3(&[d.join("VST3").to_string_lossy().into_owned()]);
            let noms: Vec<String> = v.iter().map(|p| p.strip_prefix(&d).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()).collect();
            assert!(noms.contains(&"VST3/TONE3000.vst3/Contents/x86_64-win/TONE3000.vst3".to_string()), "{noms:?}");
            assert!(noms.contains(&"VST3/Blue Cat's/BC Axiom VST3.vst3".to_string()), "sous-dossier d'éditeur : {noms:?}");
            assert!(noms.contains(&"VST3/Autre.vst3/Contents/x86_64-win/nom_different.vst3".to_string()), "premier .vst3 du dossier si le nom diffère");
            assert!(noms.contains(&"VST3/Vide.vst3".to_string()), "bundle sans binaire : le dossier est gardé tel quel");
            assert_eq!(noms.len(), 4, "pas de doublon avec le fichier intérieur : {noms:?}");
            let _ = std::fs::remove_dir_all(&d);
        }

        #[test]
        fn un_plugin_precis_ajoute_a_la_main_fichier_bundle_ou_dll() {
            let d = arbre("main");
            touche(&d.join("ailleurs/MonPlugin.vst3"));
            touche(&d.join("ailleurs2/Gros.vst3/Contents/x86_64-win/Gros.vst3"));
            touche(&d.join("vst2/Vieux.dll"));
            touche(&d.join("vst2/Autre.dll"));
            let v3 = list_vst3(&[format!("  {}  ", d.join("ailleurs/MonPlugin.vst3").to_string_lossy()), d.join("ailleurs2/Gros.vst3").to_string_lossy().into_owned(), "C:/n/existe/pas.vst3".into()]);
            assert_eq!(v3.len(), 2, "{v3:?}");
            assert!(v3[0].ends_with("MonPlugin.vst3") || v3[1].ends_with("MonPlugin.vst3"));
            assert!(v3.iter().any(|p| p.ends_with("x86_64-win/Gros.vst3") || p.ends_with("x86_64-win\\Gros.vst3")), "bundle ajouté à la main : binaire intérieur");
            let v2 = list_vst2(&[d.join("vst2/Vieux.dll").to_string_lossy().into_owned()]);
            assert_eq!(v2.len(), 1); assert!(v2[0].ends_with("Vieux.dll"));
            assert_eq!(list_vst2(&[d.join("vst2").to_string_lossy().into_owned()]).len(), 2, "un dossier est toujours parcouru");
            let _ = std::fs::remove_dir_all(&d);
        }
    }
}
