//! Lecture / écriture de fichiers texte demandées par l'interface (projets .carxp, JSON, rapports).
use std::path::Path;

const MAX_READ: u64 = 64 * 1024 * 1024;
const MAX_WRITE: usize = 64 * 1024 * 1024;
const ALLOWED: [&str; 6] = ["carxp", "json", "md", "txt", "xml", "csv"];

fn check_ext(path: &Path) -> Result<(), String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ALLOWED.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!("Extension non autorisée « .{ext} » (autorisées : {}).", ALLOWED.join(", ")))
    }
}

pub fn read_text_file(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    check_ext(p)?;
    let meta = std::fs::metadata(p).map_err(|e| format!("Fichier illisible « {path} » : {e}"))?;
    if !meta.is_file() {
        return Err(format!("« {path} » n'est pas un fichier."));
    }
    if meta.len() > MAX_READ {
        return Err(format!("Fichier trop gros ({} Mo, maximum {} Mo).", meta.len() / 1_048_576, MAX_READ / 1_048_576));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("« {path} » n'est pas un fichier texte UTF-8."))
}

/// Fichiers binaires que l'interface peut lire (presets de plugins). Lecture seule.
const BINARY_READ: [&str; 1] = ["t3kpreset"];
const MAX_BINARY: u64 = 64 * 1024 * 1024;
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c.first().copied().unwrap_or(0)) << 16) | (u32::from(c.get(1).copied().unwrap_or(0)) << 8) | u32::from(c.get(2).copied().unwrap_or(0));
        for i in 0..4 {
            if i <= c.len() { out.push(char::from(B64.get(((n >> (18 - 6 * i)) & 63) as usize).copied().unwrap_or(b'='))); } else { out.push('='); }
        }
    }
    out
}

/// Lit un fichier binaire autorisé (.t3kpreset) et le renvoie en base64.
pub fn read_binary_base64(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !BINARY_READ.contains(&ext.as_str()) {
        return Err(format!("Extension non autorisée « .{ext} » pour une lecture binaire (autorisée : {}).", BINARY_READ.join(", ")));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("Fichier illisible « {path} » : {e}"))?;
    if meta.len() > MAX_BINARY {
        return Err(format!("« {path} » est trop gros ({} Mo, maximum {} Mo).", meta.len() / (1024 * 1024), MAX_BINARY / (1024 * 1024)));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Lecture impossible de « {path} » : {e}"))?;
    Ok(base64_encode(&bytes))
}

pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    let p = Path::new(path);
    check_ext(p)?;
    if content.len() > MAX_WRITE {
        return Err("Contenu trop gros pour être écrit.".to_string());
    }
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            return Err(format!("Le dossier « {} » n'existe pas.", dir.display()));
        }
    }
    std::fs::write(p, content).map_err(|e| format!("Écriture impossible de « {path} » : {e}"))
}

/// Pour chaque chemin : le fichier (ou le dossier-bundle `.vst3`) existe-t-il encore ?
pub fn existing_files(paths: &[String]) -> Vec<bool> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            !p.trim().is_empty() && (path.is_file() || path.is_dir())
        })
        .collect()
}

/// Chemin d'un fichier temporaire pour l'application (ex. projet à charger dans Carla).
pub fn temp_path(name: &str) -> Result<String, String> {
    let clean: String = name.chars().filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    if clean.is_empty() {
        return Err("Nom de fichier temporaire vide.".to_string());
    }
    Ok(std::env::temp_dir().join(clean).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aller_retour_et_refus() {
        let p = temp_path("carla_core_test.carxp").unwrap_or_default();
        assert!(write_text_file(&p, "é<xml/>").is_ok());
        assert_eq!(read_text_file(&p).unwrap_or_default(), "é<xml/>");
        let _ = std::fs::remove_file(&p);
        assert!(write_text_file("/tmp/x.exe", "a").is_err());
        assert!(read_text_file("/tmp/inexistant.carxp").is_err());
        assert!(write_text_file("/dossier/inconnu/x.json", "{}").is_err());
        assert!(temp_path("../..").map(|s| s.ends_with("..")).unwrap_or(false));
        assert!(temp_path("///").is_err());
    }

    #[test]
    fn verification_des_fichiers() {
        let dir = std::env::temp_dir().join(format!("carla_core_exist_{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("Bundle.vst3"));
        let fichier = dir.join("a.dll");
        let _ = std::fs::write(&fichier, b"x");
        let r = existing_files(&[
            fichier.to_string_lossy().into_owned(),
            dir.join("Bundle.vst3").to_string_lossy().into_owned(),
            dir.join("absent.dll").to_string_lossy().into_owned(),
            String::new(),
        ]);
        assert_eq!(r, vec![true, true, false, false]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lecture_binaire_en_base64() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(&[0, 255, 254, 1]), "AP/+AQ==");
        let p = temp_path("t3k_test.t3kpreset").unwrap_or_default();
        let _ = std::fs::write(&p, [0u8, 1, 2, 250, 251, 252]);
        assert_eq!(read_binary_base64(&p).unwrap_or_default(), "AAEC+vv8");
        assert!(read_binary_base64("/tmp/x.exe").is_err(), "extension refusée");
        assert!(read_binary_base64("/tmp/inexistant.t3kpreset").is_err());
        let _ = std::fs::remove_file(&p);
    }
}
