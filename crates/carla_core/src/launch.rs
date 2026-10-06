//! Lancer Carla avec un projet (.carxp).
use crate::proc::no_window;
use std::path::Path;
use std::process::{Command, Stdio};

/// Lance `Carla.exe [projet]` sans attendre sa fin. Renvoie l'identifiant du processus.
pub fn launch_carla(exe: &str, project: Option<&str>) -> Result<u32, String> {
    let exe_path = Path::new(exe);
    if !exe_path.is_file() {
        return Err(format!("Carla introuvable : {exe}"));
    }
    let mut cmd = Command::new(exe_path);
    if let Some(dir) = exe_path.parent() {
        cmd.current_dir(dir);
    }
    if let Some(p) = project {
        if !Path::new(p).is_file() {
            return Err(format!("Projet introuvable : {p}"));
        }
        cmd.arg(p);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    no_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Impossible de lancer Carla : {e}"))?;
    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erreurs_propres() {
        assert!(launch_carla("/n/existe/pas.exe", None).is_err());
        assert!(launch_carla("/bin/sh", Some("/n/existe/pas.carxp")).is_err());
    }
}
