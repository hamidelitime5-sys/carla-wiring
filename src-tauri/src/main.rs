// Carla Wiring : couche Tauri, volontairement fine. Toute la logique est dans `carla_core` (testée).
// Règle : aucune commande ne peut faire planter l'application ; toutes renvoient `Result<T, String>`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)
)]

use carla_core::presets::{self, CancelFlag};
use carla_core::{ai, files, launch, scan};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Exécute un travail bloquant hors du thread de l'interface.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(format!("Tâche interrompue : {e}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequest {
    discovery: String,
    vst3: Vec<String>,
    vst2: Vec<String>,
    timeout_secs: Option<u64>,
}

#[tauri::command]
async fn find_discovery() -> Result<Option<String>, String> {
    blocking(|| Ok(scan::find_discovery().map(|p| p.to_string_lossy().into_owned()))).await
}

#[tauri::command]
async fn scan_plugins(app: AppHandle, req: ScanRequest) -> Result<scan::ScanReport, String> {
    blocking(move || {
        let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(60).clamp(5, 600));
        scan::scan_all(Path::new(&req.discovery), &req.vst3, &req.vst2, timeout, &mut |p| {
            let _ = app.emit("scan-progress", p);
        })
    })
    .await
}

/// Interroge l'assistant IA (Claude, ChatGPT ou Gemini). La clé n'est jamais journalisée.
#[tauri::command]
async fn ai_ask(app: AppHandle, req: ai::AiRequest) -> Result<String, String> {
    blocking(move || {
        // un modèle local peut être lent (chargement en mémoire, calcul sur processeur) : délai beaucoup plus long
        let timeout = Duration::from_secs(if req.provider == "ollama" { 900 } else { 180 });
        ai::ask_with_retry(&req, timeout, &mut |secs| {
            let _ = app.emit("ai-wait", secs); // l'interface affiche « nouvel essai dans N s »
        })
    })
    .await
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    blocking(move || files::read_text_file(&path)).await
}

#[tauri::command]
async fn read_binary_file(path: String) -> Result<String, String> {
    blocking(move || files::read_binary_base64(&path)).await
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    blocking(move || files::write_text_file(&path, &content)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetScanRequest {
    roots: Vec<String>,
    extensions: Vec<String>,
    max_entries: Option<usize>,
}

/// Scanne les presets (dossiers précis ou disque entier). Arrêtable avec `cancel_preset_scan`.
#[tauri::command]
async fn scan_presets(app: AppHandle, state: State<'_, CancelFlag>, req: PresetScanRequest) -> Result<presets::PresetScanReport, String> {
    let cancel = state.inner().clone();
    cancel.reset();
    blocking(move || {
        let max = req.max_entries.unwrap_or(50_000).clamp(100, 200_000);
        presets::scan_presets(&req.roots, &req.extensions, max, &cancel, &mut |p| {
            let _ = app.emit("preset-progress", p);
        })
    })
    .await
}

#[tauri::command]
fn cancel_preset_scan(state: State<'_, CancelFlag>) {
    state.cancel();
}

/// Compte les extensions d'un dossier (pour découvrir le format de preset d'un plugin).
#[tauri::command]
async fn scan_extensions(state: State<'_, CancelFlag>, folder: String) -> Result<Vec<presets::ExtCount>, String> {
    let cancel = state.inner().clone();
    cancel.reset();
    blocking(move || presets::scan_extensions(&folder, 200_000, &cancel)).await
}

/// Pour chaque plugin (indices = noms simplifiés), trouve les dossiers de presets/réglages correspondants et leurs formats.
#[tauri::command]
async fn discover_preset_dirs(state: State<'_, CancelFlag>, hints: Vec<String>, extra_roots: Vec<String>) -> Result<Vec<presets::DiscoveredDir>, String> {
    let cancel = state.inner().clone();
    cancel.reset();
    blocking(move || {
        let mut roots = presets::default_roots();
        roots.extend(extra_roots);
        presets::discover_dirs(&roots, &hints, 4, &cancel)
    })
    .await
}

/// Décrit chaque sous-dossier d'un dossier (formats trouvés) pour choisir quoi scanner.
#[tauri::command]
async fn analyse_subfolders(state: State<'_, CancelFlag>, folder: String) -> Result<Vec<presets::SubfolderInfo>, String> {
    let cancel = state.inner().clone();
    cancel.reset();
    blocking(move || presets::analyse_subfolders(&folder, 100_000, &cancel)).await
}

/// Dossier de données de l'application (index des presets, sons capturés), créé au besoin.
#[tauri::command]
fn data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("Dossier de données introuvable : {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Impossible de créer {} : {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Pour chaque chemin de plugin : le fichier existe-t-il encore ? (vérification avant un concert)
#[tauri::command]
async fn check_paths(paths: Vec<String>) -> Result<Vec<bool>, String> {
    blocking(move || Ok(files::existing_files(&paths))).await
}

#[tauri::command]
fn launch_carla(exe: String, project: Option<String>) -> Result<u32, String> {
    launch::launch_carla(&exe, project.as_deref())
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CancelFlag::default())
        .invoke_handler(tauri::generate_handler![find_discovery, scan_plugins, ai_ask, read_text_file, read_binary_file, write_text_file, check_paths, launch_carla, scan_presets, cancel_preset_scan, scan_extensions, analyse_subfolders, discover_preset_dirs, data_dir])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("Erreur au démarrage de Carla Wiring : {e}");
    }
}
