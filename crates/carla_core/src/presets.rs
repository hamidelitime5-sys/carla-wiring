//! Scan des presets de plugins sur le disque (.fxp, .fxb, .vstpreset, .preset…).
//!
//! Sécurités : les liens symboliques et jonctions ne sont pas suivis (pas de boucle), les dossiers système sont
//! ignorés, la profondeur et le nombre de résultats sont bornés, et le scan peut être arrêté à tout moment.
//! Les en-têtes des fichiers VST2 (.fxp/.fxb) donnent l'identifiant du plugin (comme `UniqueID` dans un .carxp)
//! et le nom du preset ; ceux des .vstpreset donnent l'identifiant de classe VST3.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const MAX_DEPTH: usize = 16;
const EXCLUDED_DIRS: [&str; 9] = [
    "windows", "$recycle.bin", "system volume information", "$windows.~bt", "$windows.~ws", "winsxs", "node_modules", ".git", "recovery",
];

/// Indicateur d'arrêt partagé entre la commande d'annulation et le scan en cours.
#[derive(Clone, Default)]
pub struct CancelFlag(pub Arc<AtomicBool>);

impl CancelFlag {
    pub fn reset(&self) { self.0.store(false, Ordering::SeqCst); }
    pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst); }
    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresetEntry {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: String, // "fxp" | "fxb" | "vstpreset" | "other"
    pub vst_id: Option<u32>,
    pub class_id: Option<String>,
    pub hints: Vec<String>, // noms des 6 dossiers parents (aident à reconnaître le plugin)
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetProgress {
    pub dirs: usize,
    pub found: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetScanReport {
    pub entries: Vec<PresetEntry>,
    pub visited_dirs: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub unreadable: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExtCount {
    pub ext: String,
    pub count: usize,
    pub example: String,
}

/// En-tête d'un fichier VST2 (.fxp / .fxb).
#[derive(Debug, PartialEq)]
pub struct FxHeader {
    pub magic: String, // FxCk, FPCh (preset), FxBk, FBCh (banque)
    pub id: u32,
    pub name: Option<String>,
}

pub fn parse_fx(bytes: &[u8]) -> Option<FxHeader> {
    if bytes.get(0..4)? != b"CcnK" {
        return None;
    }
    let magic = String::from_utf8_lossy(bytes.get(8..12)?).into_owned();
    if !["FxCk", "FPCh", "FxBk", "FBCh"].contains(&magic.as_str()) {
        return None;
    }
    let id = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let name = if magic == "FxCk" || magic == "FPCh" {
        let raw: Vec<u8> = bytes.get(28..56).unwrap_or(&[]).iter().copied().take_while(|b| *b != 0).collect();
        let n: String = raw.iter().map(|b| char::from(*b)).collect::<String>().trim().to_string();
        if n.is_empty() { None } else { Some(n) }
    } else {
        None
    };
    Some(FxHeader { magic, id, name })
}

/// Identifiant de classe (32 caractères hexadécimaux) d'un .vstpreset.
pub fn parse_vstpreset(bytes: &[u8]) -> Option<String> {
    if bytes.get(0..4)? != b"VST3" {
        return None;
    }
    let id = String::from_utf8_lossy(bytes.get(8..40)?).into_owned();
    if id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()) { Some(id.to_uppercase()) } else { None }
}

fn read_head(path: &Path) -> Vec<u8> {
    let mut buf = [0u8; 64];
    let n = fs::File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    buf.get(..n).map(<[u8]>::to_vec).unwrap_or_default()
}

fn is_excluded(name: &str) -> bool {
    let n = name.to_lowercase();
    EXCLUDED_DIRS.contains(&n.as_str())
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn hints_of(p: &Path) -> Vec<String> {
    p.ancestors().skip(1).take(6).filter_map(|a| a.file_name().map(|n| n.to_string_lossy().into_owned())).collect()
}

fn make_entry(path: &Path, ext: &str, size: u64) -> PresetEntry {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (kind, vst_id, class_id, name) = match ext {
        "fxp" | "fxb" => {
            let h = parse_fx(&read_head(path));
            (ext.to_string(), h.as_ref().map(|x| x.id), None, h.and_then(|x| x.name).unwrap_or(stem))
        }
        "vstpreset" => ("vstpreset".to_string(), None, parse_vstpreset(&read_head(path)), stem),
        _ => ("other".to_string(), None, None, stem),
    };
    PresetEntry { path: path.to_string_lossy().into_owned(), name, ext: ext.to_string(), kind, vst_id, class_id, hints: hints_of(path), size }
}

/// Parcourt les dossiers `roots` (le disque entier, par exemple `C:\`) à la recherche des fichiers dont l'extension est dans `extensions`.
pub fn scan_presets(
    roots: &[String], extensions: &[String], max_entries: usize, cancel: &CancelFlag, progress: &mut dyn FnMut(PresetProgress),
) -> Result<PresetScanReport, String> {
    let exts: HashSet<String> = extensions.iter().map(|e| e.trim().trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty()).collect();
    if exts.is_empty() {
        return Err("Indiquez au moins une extension de preset (ex. fxp, vstpreset).".to_string());
    }
    let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|r| PathBuf::from(r.trim())).filter(|p| p.is_dir()).map(|p| (p, 0)).collect();
    if stack.is_empty() {
        return Err("Aucun des dossiers indiqués n'existe.".to_string());
    }
    let mut report = PresetScanReport { entries: Vec::new(), visited_dirs: 0, truncated: false, cancelled: false, unreadable: 0 };
    'outer: while let Some((dir, depth)) = stack.pop() {
        if cancel.is_cancelled() {
            report.cancelled = true;
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { report.unreadable += 1; continue };
        report.visited_dirs += 1;
        if report.visited_dirs % 100 == 0 {
            progress(PresetProgress { dirs: report.visited_dirs, found: report.entries.len(), current: dir.to_string_lossy().into_owned() });
        }
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue; // pas de liens ni de jonctions : évite les boucles et les doublons
            }
            let path = entry.path();
            if ft.is_dir() {
                if depth < MAX_DEPTH && !is_excluded(&entry.file_name().to_string_lossy()) {
                    stack.push((path, depth + 1));
                }
            } else if ft.is_file() {
                let ext = ext_of(&path);
                if exts.contains(&ext) {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    report.entries.push(make_entry(&path, &ext, size));
                    if report.entries.len() >= max_entries {
                        report.truncated = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    progress(PresetProgress { dirs: report.visited_dirs, found: report.entries.len(), current: String::new() });
    Ok(report)
}

fn count_exts(root: &Path, max_files: usize, cancel: &CancelFlag) -> (usize, Vec<ExtCount>) {
    let mut counts: HashMap<String, (usize, String)> = HashMap::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut files = 0usize;
    'outer: while let Some((dir, depth)) = stack.pop() {
        if cancel.is_cancelled() { break; }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() { continue; }
            if ft.is_dir() {
                if depth < MAX_DEPTH && !is_excluded(&entry.file_name().to_string_lossy()) { stack.push((entry.path(), depth + 1)); }
            } else if ft.is_file() {
                let ext = ext_of(&entry.path());
                let key = if ext.is_empty() { "(sans extension)".to_string() } else { ext };
                let slot = counts.entry(key).or_insert_with(|| (0, entry.path().to_string_lossy().into_owned()));
                slot.0 += 1;
                files += 1;
                if files >= max_files { break 'outer; }
            }
        }
    }
    let mut out: Vec<ExtCount> = counts.into_iter().map(|(ext, (count, example))| ExtCount { ext, count, example }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.ext.cmp(&b.ext)));
    (files, out)
}

/// Compte les extensions de fichiers d'un dossier (pour découvrir quel format de preset utilise un plugin).
pub fn scan_extensions(folder: &str, max_files: usize, cancel: &CancelFlag) -> Result<Vec<ExtCount>, String> {
    let root = PathBuf::from(folder.trim());
    if !root.is_dir() {
        return Err(format!("Dossier introuvable : {folder}"));
    }
    let (_, mut out) = count_exts(&root, max_files, cancel);
    out.truncate(40);
    Ok(out)
}

/// Résumé d'un sous-dossier : nombre de fichiers et formats les plus fréquents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubfolderInfo {
    pub name: String,
    pub path: String,
    pub files: usize,
    pub exts: Vec<ExtCount>,
}

/// Décrit chaque sous-dossier direct de `folder` (ex. `Guitar Rig 7\Content` : un dossier par composant), plus les fichiers
/// posés directement dans `folder`. Sert à voir quel sous-dossier contient quels formats avant de choisir quoi scanner.
pub fn analyse_subfolders(folder: &str, max_files: usize, cancel: &CancelFlag) -> Result<Vec<SubfolderInfo>, String> {
    let root = PathBuf::from(folder.trim());
    if !root.is_dir() {
        return Err(format!("Dossier introuvable : {folder}"));
    }
    let Ok(rd) = fs::read_dir(&root) else { return Err(format!("Dossier illisible : {folder}")) };
    let mut out: Vec<SubfolderInfo> = Vec::new();
    let mut direct: HashMap<String, (usize, String)> = HashMap::new();
    for entry in rd.flatten() {
        if cancel.is_cancelled() { break; }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() {
            if is_excluded(&name) { continue; }
            let (files, mut exts) = count_exts(&entry.path(), max_files, cancel);
            exts.truncate(8);
            out.push(SubfolderInfo { name, path: entry.path().to_string_lossy().into_owned(), files, exts });
        } else if ft.is_file() {
            let ext = ext_of(&entry.path());
            let key = if ext.is_empty() { "(sans extension)".to_string() } else { ext };
            direct.entry(key).or_insert_with(|| (0, entry.path().to_string_lossy().into_owned())).0 += 1;
        }
    }
    if !direct.is_empty() {
        let files = direct.values().map(|v| v.0).sum();
        let mut exts: Vec<ExtCount> = direct.into_iter().map(|(ext, (count, example))| ExtCount { ext, count, example }).collect();
        exts.sort_by(|a, b| b.count.cmp(&a.count).then(a.ext.cmp(&b.ext)));
        out.push(SubfolderInfo { name: "(fichiers posés directement dans ce dossier)".to_string(), path: root.to_string_lossy().into_owned(), files, exts });
    }
    out.sort_by(|a, b| b.files.cmp(&a.files).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Un dossier qui correspond à un plugin ou à un éditeur, avec les formats de fichiers qu'il contient.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDir {
    pub path: String,
    pub name: String,
    pub files: usize,
    pub exts: Vec<ExtCount>,
}

fn basic(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Emplacements habituels où les plugins rangent leurs presets et réglages : AppData, ProgramData, Documents,
/// et Program Files (dont « Common Files », où Native Instruments, Avid… installent leur contenu).
pub fn default_roots() -> Vec<String> {
    let mut cand: Vec<PathBuf> = Vec::new();
    for var in ["APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = std::env::var_os(var) { cand.push(PathBuf::from(p)); }
    }
    if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) {
        cand.push(h.join("Documents"));
    }
    for fixed in [r"C:\Program Files", r"C:\Program Files (x86)", r"C:\Users\Public\Documents"] { cand.push(PathBuf::from(fixed)); }
    let mut seen = HashSet::new();
    let uniq: Vec<PathBuf> = cand.into_iter().filter(|p| p.is_dir() && seen.insert(p.clone())).collect();
    // inutile de parcourir un dossier déjà contenu dans un autre
    let keep: Vec<PathBuf> = uniq.iter().filter(|p| !uniq.iter().any(|q| q != *p && p.starts_with(q))).cloned().collect();
    keep.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Cherche, sous `roots`, les dossiers (profondeur ≤ `max_depth`) dont le nom correspond à l'un des `hints`
/// (noms de plugins ou d'éditeurs, déjà simplifiés), et décrit les formats de fichiers qu'ils contiennent.
/// On ne descend pas dans un dossier trouvé : ses sous-dossiers sont comptés avec lui.
pub fn discover_dirs(roots: &[String], hints: &[String], max_depth: usize, cancel: &CancelFlag) -> Result<Vec<DiscoveredDir>, String> {
    let hints: HashSet<String> = hints.iter().map(|h| basic(h)).filter(|h| h.chars().count() >= 4).collect();
    if hints.is_empty() {
        return Err("Aucun nom de plugin exploitable : scannez d'abord vos plugins (onglet Plugins).".to_string());
    }
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> = roots.iter().map(|r| PathBuf::from(r.trim())).filter(|p| p.is_dir()).map(|p| (p, 0)).collect();
    if queue.is_empty() {
        return Err("Aucun dossier à explorer.".to_string());
    }
    let mut found: Vec<DiscoveredDir> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    while let Some((dir, depth)) = queue.pop_front() {
        if cancel.is_cancelled() { break; }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_excluded(&name) { continue; }
            let path = entry.path();
            let b = basic(&name);
            // nom de 4 lettres (ex. MXXX) : le dossier doit se TERMINER par ce nom ; au-delà, il suffit qu'il le contienne
            let matched = b.chars().count() >= 4
                && hints.iter().any(|h| {
                    let (bl, hl) = (b.chars().count(), h.chars().count());
                    if hl == 4 { b.ends_with(h.as_str()) }
                    // le nom du dossier est contenu dans le plugin (ex. « player » dans « SynthMaster 2 Player ») : seulement s'il en couvre
                    // au moins la moitié, sinon c'est un mot courant et non le dossier du plugin
                    else { b.contains(h.as_str()) || (bl >= 6 && bl * 2 >= hl && h.contains(b.as_str())) }
                });
            if matched {
                if seen.insert(path.clone()) {
                    let (files, mut exts) = count_exts(&path, 20_000, cancel);
                    if files > 0 {
                        exts.truncate(15);
                        found.push(DiscoveredDir { path: path.to_string_lossy().into_owned(), name, files, exts });
                    }
                }
            } else if depth + 1 < max_depth {
                queue.push_back((path, depth + 1));
            }
        }
    }
    found.sort_by(|a, b| b.files.cmp(&a.files).then(a.path.cmp(&b.path)));
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(magic: &[u8; 4], id: &[u8; 4], name: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(b"CcnK"); v.extend(100u32.to_be_bytes()); v.extend(magic); v.extend(1u32.to_be_bytes());
        v.extend(id); v.extend(1u32.to_be_bytes()); v.extend(2u32.to_be_bytes());
        let mut n = [0u8; 28]; n[..name.len()].copy_from_slice(name.as_bytes()); v.extend(n); v.extend([0u8; 8]); v
    }
    fn vstp(cid: &str) -> Vec<u8> { let mut v = b"VST3".to_vec(); v.extend(1u32.to_le_bytes()); v.extend(cid.as_bytes()); v.extend(0i64.to_le_bytes()); v }
    fn tmp(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("carla_presets_{nom}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d); let _ = fs::create_dir_all(&d); d
    }
    fn write(p: &Path, bytes: &[u8]) { if let Some(d) = p.parent() { let _ = fs::create_dir_all(d); } let _ = fs::write(p, bytes); }

    #[test]
    fn en_tetes_vst2_et_vst3() {
        let h = parse_fx(&fx(b"FxCk", b"LpRc", "Clean Jazz")).unwrap();
        assert_eq!(h.magic, "FxCk"); assert_eq!(h.id, u32::from_be_bytes(*b"LpRc")); assert_eq!(h.name.as_deref(), Some("Clean Jazz"));
        assert_eq!(parse_fx(&fx(b"FxBk", b"abcd", "x")).unwrap().name, None, "une banque n'a pas de nom de preset");
        assert!(parse_fx(b"pas un fxp du tout, vraiment pas, non non non").is_none());
        assert!(parse_fx(b"CcnK").is_none(), "fichier tronqué");
        assert_eq!(parse_vstpreset(&vstp("ABCDEF0123456789ABCDEF0123456789")).as_deref(), Some("ABCDEF0123456789ABCDEF0123456789"));
        assert!(parse_vstpreset(&vstp("pas-hexadecimal-pas-hexadecimal--")).is_none());
        assert!(parse_vstpreset(b"VST3").is_none());
    }

    #[test]
    fn scan_complet_avec_exclusions_et_extensions() {
        let d = tmp("scan");
        write(&d.join("VST3 Presets/Blue Cat/Axiom/Basse.vstpreset"), &vstp("ABCDEF0123456789ABCDEF0123456789"));
        write(&d.join("Loop/Presets/x.fxp"), &fx(b"FxCk", b"LpRc", "Boucle claire"));
        write(&d.join("Loop/Banks/b.fxb"), &fx(b"FxBk", b"LpRc", ""));
        write(&d.join("Autre/sans_en_tete.fxp"), b"n'importe quoi");
        write(&d.join("Autre/note.txt"), b"x");
        write(&d.join("Windows/System32/cache.fxp"), &fx(b"FxCk", b"zzzz", "Ignoré"));
        write(&d.join("node_modules/x/y.fxp"), &fx(b"FxCk", b"zzzz", "Ignoré aussi"));
        let mut etapes = 0;
        let r = scan_presets(&[d.to_string_lossy().into_owned()], &["fxp".into(), ".FXB".into(), "vstpreset".into()], 1000, &CancelFlag::default(), &mut |_| etapes += 1).unwrap();
        assert_eq!(r.entries.len(), 4, "{:?}", r.entries.iter().map(|e| &e.path).collect::<Vec<_>>());
        assert!(r.entries.iter().all(|e| !e.path.contains("Windows") && !e.path.contains("node_modules")));
        let lp = r.entries.iter().find(|e| e.name == "Boucle claire").unwrap();
        assert_eq!(lp.vst_id, Some(u32::from_be_bytes(*b"LpRc"))); assert_eq!(lp.hints[..2], ["Presets".to_string(), "Loop".to_string()]);
        let basse = r.entries.iter().find(|e| e.kind == "vstpreset").unwrap();
        assert_eq!(basse.name, "Basse"); assert_eq!(basse.class_id.as_deref(), Some("ABCDEF0123456789ABCDEF0123456789"));
        let sans = r.entries.iter().find(|e| e.path.ends_with("sans_en_tete.fxp")).unwrap();
        assert_eq!((sans.name.as_str(), sans.vst_id), ("sans_en_tete", None), "fichier sans en-tête valide : nom du fichier");
        assert!(etapes >= 1 && !r.truncated && !r.cancelled);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn plafond_arret_et_erreurs() {
        let d = tmp("plafond");
        for i in 0..30 { write(&d.join(format!("a/p{i}.fxp")), b"x"); }
        let r = scan_presets(&[d.to_string_lossy().into_owned()], &["fxp".into()], 10, &CancelFlag::default(), &mut |_| {}).unwrap();
        assert_eq!(r.entries.len(), 10); assert!(r.truncated);
        let stop = CancelFlag::default(); stop.cancel();
        let r2 = scan_presets(&[d.to_string_lossy().into_owned()], &["fxp".into()], 1000, &stop, &mut |_| {}).unwrap();
        assert!(r2.cancelled && r2.entries.is_empty());
        assert!(scan_presets(&[d.to_string_lossy().into_owned()], &[], 10, &CancelFlag::default(), &mut |_| {}).is_err());
        assert!(scan_presets(&["/n/existe/pas".into()], &["fxp".into()], 10, &CancelFlag::default(), &mut |_| {}).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn les_liens_symboliques_ne_sont_pas_suivis() {
        let d = tmp("lien");
        write(&d.join("reel/p.fxp"), b"x");
        let _ = std::os::unix::fs::symlink(&d, d.join("reel/boucle"));
        let _ = std::os::unix::fs::symlink(d.join("reel/p.fxp"), d.join("reel/lien.fxp"));
        let r = scan_presets(&[d.to_string_lossy().into_owned()], &["fxp".into()], 100, &CancelFlag::default(), &mut |_| {}).unwrap();
        assert_eq!(r.entries.len(), 1, "ni boucle infinie, ni doublon par lien");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn decouverte_automatique_des_dossiers_de_plugins() {
        let d = tmp("decouverte");
        for f in ["Roaming/MeldaProduction/MeldaProduction MXXX/Presets/Delay/a.mpreset", "Roaming/MeldaProduction/MeldaProduction MXXX/Presets/b.mpreset",
            "Roaming/MeldaProduction/MeldaProduction MXXX/fenetre.winstate", "Roaming/MeldaProduction/MeldaProduction MXXX/ActivePresets/x.active",
            "Docs/VST3 Presets/Blue Cat/Axiom/Basse.vstpreset", "Roaming/Autre Editeur/Truc/readme.txt", "Windows/Axiom/ignore.fxp"] {
            write(&d.join(f), b"x");
        }
        let roots = [d.to_string_lossy().into_owned()];
        let r = discover_dirs(&roots, &["MXXX".into(), "Axiom".into(), "court".into()], 4, &CancelFlag::default()).unwrap();
        let noms: Vec<_> = r.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(noms.len(), 2, "{noms:?}");
        let melda = r.iter().find(|x| x.name == "MeldaProduction MXXX").unwrap();
        assert_eq!(melda.files, 4);
        assert_eq!((melda.exts[0].ext.as_str(), melda.exts[0].count), ("mpreset", 2));
        assert!(melda.exts.iter().any(|e| e.ext == "winstate") && melda.exts.iter().any(|e| e.ext == "active"), "tous les formats sont listés, c\'est l\'utilisateur qui trie");
        assert!(r.iter().any(|x| x.name == "Axiom" && x.exts[0].ext == "vstpreset"));
        assert!(!r.iter().any(|x| x.path.contains("Windows")), "dossiers système ignorés");
        assert!(discover_dirs(&roots, &["abc".into()], 4, &CancelFlag::default()).is_err(), "indices trop courts refusés");
        write(&d.join("Roaming/Maxxx Drums/p.fxp"), b"x");
        let r2 = discover_dirs(&roots, &["MXXX".into()], 4, &CancelFlag::default()).unwrap();
        assert!(!r2.iter().any(|x| x.name == "Maxxx Drums"), "un nom de 4 lettres ne doit pas correspondre au milieu d\'un autre nom");
        assert!(discover_dirs(&["/n/existe/pas".into()], &["axiomtest".into()], 4, &CancelFlag::default()).is_err());
        let profond = discover_dirs(&roots, &["MXXX".into()], 1, &CancelFlag::default()).unwrap();
        assert!(profond.is_empty(), "profondeur limitée");
        assert!(!default_roots().iter().any(|p| p.is_empty()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn guitar_rig_et_faux_positifs() {
        let d = tmp("gr");
        for f in ["Common Files/Native Instruments/Guitar Rig 7/Rack Presets/Super Crunch.ngrr", "Common Files/Native Instruments/Guitar Rig 7/Rack Presets/Stoney Fuzz.ngrr",
            "Common Files/Native Instruments/Guitar Rig 7/Rack Presets/Sub/Autre.ngrr", "Roaming/utorrent/player/a.dll", "Roaming/Steinberg/Cubase/Scripts/x.txt"] {
            write(&d.join(f), b"x");
        }
        let roots = [d.to_string_lossy().into_owned()];
        let hints = ["Guitar Rig 7".to_string(), "guitarrig7".into(), "synthmaster2player".into(), "plugnscriptsynth".into()];
        let r = discover_dirs(&roots, &hints, 4, &CancelFlag::default()).unwrap();
        let noms: Vec<_> = r.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(noms, vec!["Guitar Rig 7"], "{noms:?} : « player » et « Scripts » ne sont pas des dossiers de plugins");
        assert_eq!((r[0].files, r[0].exts[0].ext.as_str(), r[0].exts[0].count), (3, "ngrr", 3), "sous-dossiers de presets inclus");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn analyse_par_sous_dossier() {
        let d = tmp("sous");
        for f in ["Content/Reflektor/Presets/a.ngrr", "Content/Reflektor/Presets/b.ngrr", "Content/Reflektor/ir.wav", "Content/Matched Cabinet Pro/c1.ncw",
            "Content/Matched Cabinet Pro/c2.ncw", "Content/Matched Cabinet Pro/c3.ncw", "Content/Metronome/m.wav", "Content/readme.txt", "Content/Windows/ignore.fxp"] {
            write(&d.join(f), b"x");
        }
        let r = analyse_subfolders(&d.join("Content").to_string_lossy(), 1000, &CancelFlag::default()).unwrap();
        let noms: Vec<_> = r.iter().map(|x| (x.name.as_str(), x.files)).collect();
        assert_eq!(noms[0], ("Matched Cabinet Pro", 3), "{noms:?}"); assert_eq!(noms[1], ("Reflektor", 3), "sous-dossiers inclus dans le total");
        assert!(noms.iter().any(|n| n.0 == "Metronome") && !noms.iter().any(|n| n.0 == "Windows"), "dossier système ignoré");
        let refl = r.iter().find(|x| x.name == "Reflektor").unwrap();
        assert_eq!((refl.exts[0].ext.as_str(), refl.exts[0].count), ("ngrr", 2));
        assert!(r.iter().any(|x| x.name.starts_with("(fichiers") && x.files == 1), "fichiers posés à la racine");
        assert!(analyse_subfolders("/n/existe/pas", 10, &CancelFlag::default()).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn decouverte_des_extensions() {
        let d = tmp("ext");
        for f in ["a/Presets/x1.bcpreset", "a/Presets/x2.bcpreset", "a/Presets/x3.bcpreset", "a/readme.txt", "a/LICENSE"] { write(&d.join(f), b"x"); }
        let r = scan_extensions(&d.to_string_lossy(), 1000, &CancelFlag::default()).unwrap();
        assert_eq!((r[0].ext.as_str(), r[0].count), ("bcpreset", 3));
        assert!(r.iter().any(|e| e.ext == "txt") && r.iter().any(|e| e.ext == "(sans extension)"));
        assert!(scan_extensions("/n/existe/pas", 10, &CancelFlag::default()).is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
