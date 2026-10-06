//! Moteur Rust de Carla Wiring (outil de PRÉPARATION : scan des plugins, fichiers, lancement de Carla).
//!
//! Règle du projet : AUCUN `unwrap()`, `expect()`, `panic!()` ni accès par indice `v[i]` en code de production.
//! Toute fonction publique renvoie `Result<T, String>` : l'erreur est un texte lisible, renvoyé tel quel à l'interface.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)
)]

pub mod ai;
pub mod files;
pub mod launch;
pub mod presets;
pub mod proc;
pub mod scan;
