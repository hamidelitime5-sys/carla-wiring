//! Appel d'un assistant IA (Claude, ChatGPT ou Gemini) depuis le moteur Rust.
//!
//! La clé API est fournie à chaque appel par l'interface ; elle n'est jamais écrite dans un journal.
//! Les erreurs HTTP sont traduites en messages lisibles (clé refusée, quota dépassé, modèle inconnu…).
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" ou "assistant"
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub provider: String, // "anthropic" | "openai" | "gemini"
    pub model: String,
    pub api_key: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    /// Pour les tests uniquement : remplace l'adresse officielle du fournisseur.
    pub base_url: Option<String>,
    pub max_tokens: Option<u32>,
    /// Ollama : taille de la fenêtre de contexte demandée (jetons).
    pub num_ctx: Option<u32>,
}

/// Adresse par défaut du serveur Ollama installé sur ce PC.
pub const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";
/// Plus grande fenêtre de contexte acceptée pour Ollama (au-delà, la mémoire explose).
pub const OLLAMA_MAX_CTX: u32 = 65536;

pub struct HttpCall {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

pub fn build_call(req: &AiRequest) -> Result<HttpCall, String> {
    if req.api_key.trim().is_empty() && req.provider != "ollama" {
        return Err("Clé API manquante : renseignez-la dans les réglages de l'assistant.".to_string());
    }
    if req.model.trim().is_empty() {
        return Err("Modèle IA non indiqué.".to_string());
    }
    if req.messages.is_empty() {
        return Err("Aucun message à envoyer.".to_string());
    }
    let max_tokens = req.max_tokens.unwrap_or(8000);
    match req.provider.as_str() {
        "anthropic" => Ok(HttpCall {
            url: format!("{}/v1/messages", req.base_url.as_deref().unwrap_or("https://api.anthropic.com")),
            headers: vec![
                ("x-api-key".into(), req.api_key.clone()),
                ("anthropic-version".into(), "2023-06-01".into()),
            ],
            body: json!({
                "model": req.model,
                "max_tokens": max_tokens,
                "system": req.system,
                "messages": req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
            }),
        }),
        "openai" => {
            let mut msgs = vec![json!({"role": "system", "content": req.system})];
            msgs.extend(req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
            Ok(HttpCall {
                url: format!("{}/v1/chat/completions", req.base_url.as_deref().unwrap_or("https://api.openai.com")),
                headers: vec![("authorization".into(), format!("Bearer {}", req.api_key))],
                body: json!({"model": req.model, "messages": msgs}),
            })
        }
        "gemini" => Ok(HttpCall {
            url: format!(
                "{}/v1beta/models/{}:generateContent",
                req.base_url.as_deref().unwrap_or("https://generativelanguage.googleapis.com"),
                req.model
            ),
            headers: vec![("x-goog-api-key".into(), req.api_key.clone())],
            body: json!({
                "systemInstruction": {"parts": [{"text": req.system}]},
                "contents": req.messages.iter().map(|m| json!({
                    "role": if m.role == "assistant" { "model" } else { "user" },
                    "parts": [{"text": m.content}]
                })).collect::<Vec<_>>(),
                "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": max_tokens},
            }),
        }),
        "ollama" => {
            let base = req.base_url.as_deref().unwrap_or(OLLAMA_DEFAULT_URL).trim_end_matches('/').to_string();
            // Ollama tronque EN SILENCE ce qui dépasse la fenêtre de contexte : on la dimensionne d'après la taille réelle du prompt.
            let chars: usize = req.system.chars().count() + req.messages.iter().map(|m| m.content.chars().count()).sum::<usize>();
            let needed = u32::try_from(chars / 3).unwrap_or(u32::MAX).saturating_add(max_tokens.min(4096)).saturating_add(512);
            let wanted = req.num_ctx.unwrap_or(16384).max(needed);
            let num_ctx = wanted.div_ceil(1024).saturating_mul(1024);
            if num_ctx > OLLAMA_MAX_CTX {
                return Err(format!("La demande (catalogue de plugins compris) est trop grosse pour un contexte Ollama de {OLLAMA_MAX_CTX} jetons (besoin estimé : {needed}). Réduisez le nombre de plugins envoyés ou choisissez un autre fournisseur."));
            }
            let mut msgs = vec![json!({"role": "system", "content": req.system})];
            msgs.extend(req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
            Ok(HttpCall {
                url: format!("{base}/api/chat"),
                headers: vec![],
                body: json!({"model": req.model, "messages": msgs, "stream": false, "format": "json", "options": {"num_ctx": num_ctx, "temperature": 0.3}}),
            })
        }
        other => Err(format!("Fournisseur IA inconnu : « {other} » (anthropic, openai, gemini ou ollama).")),
    }
}

/// Extrait le texte de la réponse selon le fournisseur.
pub fn parse_response(provider: &str, v: &Value) -> Result<String, String> {
    let text = match provider {
        "anthropic" => v.get("content").and_then(Value::as_array).map(|blocks| {
            blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")
        }),
        "openai" => v
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string),
        "gemini" => v
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
            .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")),
        "ollama" => v.get("message").and_then(|m| m.get("content")).and_then(Value::as_str).map(str::to_string),
        other => return Err(format!("Fournisseur IA inconnu : « {other} ».")),
    };
    match text {
        Some(t) if !t.trim().is_empty() => Ok(t),
        _ => Err("L'IA a renvoyé une réponse vide (ou bloquée par ses filtres).".to_string()),
    }
}

fn provider_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| e.as_str().map(str::to_string))))
        .unwrap_or_else(|| body.chars().take(300).collect())
}

/// Comme `status_message`, avec les conseils propres à chaque fournisseur (Ollama : modèle à télécharger).
pub fn status_message_for(provider: &str, code: u16, body: &str) -> String {
    if provider == "ollama" && code == 404 {
        return format!("Modèle introuvable dans Ollama : téléchargez-le avec « ollama pull <nom> » (nom exact, par exemple qwen2.5:7b), ou corrigez le nom du modèle. {}", provider_message(body));
    }
    status_message(code, body)
}

pub fn status_message(code: u16, body: &str) -> String {
    let detail = provider_message(body);
    match code {
        401 | 403 => format!("Clé API refusée ({code}) : vérifiez la clé et le fournisseur. {detail}"),
        404 => format!("Modèle introuvable ({code}) : vérifiez le nom du modèle. {detail}"),
        429 => format!("Quota ou limite de requêtes dépassé ({code}) : attendez ou changez de fournisseur/modèle. {detail}"),
        500..=599 => format!("Le serveur de l'IA est indisponible ({code}). Réessayez plus tard. {detail}"),
        _ => format!("Requête refusée par l'IA ({code}) : {detail}"),
    }
}

/// Échec d'un appel : réponse HTTP d'erreur (avec le délai d'attente éventuel demandé) ou problème de connexion.
enum CallError {
    Status { provider: String, code: u16, body: String, retry_after: Option<u64> },
    Other(String),
}

fn call_once(req: &AiRequest, timeout: Duration) -> Result<String, CallError> {
    let call = build_call(req).map_err(CallError::Other)?;
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut r = agent.post(&call.url).set("content-type", "application/json");
    for (k, v) in &call.headers {
        r = r.set(k, v);
    }
    match r.send_json(call.body) {
        Ok(resp) => {
            let v: Value = resp.into_json().map_err(|e| CallError::Other(format!("Réponse de l'IA illisible : {e}")))?;
            parse_response(&req.provider, &v).map_err(CallError::Other)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let retry_after = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
            let body = resp.into_string().unwrap_or_default();
            Err(CallError::Status { provider: req.provider.clone(), code, body, retry_after })
        }
        Err(ureq::Error::Transport(t)) if req.provider == "ollama" => Err(CallError::Other(format!(
            "Ollama ne répond pas sur {} : lancez l'application Ollama (ou « ollama serve » dans un terminal), puis réessayez. ({t})",
            req.base_url.as_deref().unwrap_or(OLLAMA_DEFAULT_URL)
        ))),
        Err(ureq::Error::Transport(t)) => Err(CallError::Other(format!("Connexion à l'IA impossible (internet ?) : {t}"))),
    }
}

impl CallError {
    fn message(self) -> String {
        match self {
            CallError::Status { provider, code, body, .. } => status_message_for(&provider, code, &body),
            CallError::Other(m) => m,
        }
    }
}

/// Envoie la requête et renvoie le texte de la réponse de l'IA (un seul essai).
pub fn ask(req: &AiRequest, timeout: Duration) -> Result<String, String> {
    call_once(req, timeout).map_err(CallError::message)
}

/// Attente maximale acceptée pour un nouvel essai automatique, en secondes.
pub const MAX_WAIT_SECS: u64 = 65;
/// Nombre de nouveaux essais automatiques après un « trop de requêtes » (429) ou un serveur surchargé (503).
pub const MAX_RETRIES: u32 = 2;

fn parse_seconds(s: &str) -> Option<u64> {
    let digits: String = s.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let f: f64 = digits.parse().ok()?;
    if f.is_finite() && f >= 0.0 { Some(f.ceil() as u64) } else { None }
}

/// Délai d'attente demandé par le fournisseur dans le corps de l'erreur
/// (Gemini : `retryDelay: "34s"` ou « Please retry in 34.1s »).
pub fn retry_delay(body: &str) -> Option<u64> {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(details) = v.get("error").and_then(|e| e.get("details")).and_then(Value::as_array) {
            for d in details {
                if let Some(n) = d.get("retryDelay").and_then(Value::as_str).and_then(parse_seconds) {
                    return Some(n);
                }
            }
        }
    }
    let i = body.find("retry in ")?;
    parse_seconds(body.get(i + "retry in ".len()..)?)
}

/// Comme `ask`, mais attend et réessaie automatiquement (2 fois au plus) quand la limite de requêtes par minute est atteinte.
/// Si le fournisseur demande une attente trop longue (quota du jour), il n'attend pas et l'explique.
/// `on_wait` est appelé avec la durée d'attente avant chaque pause (pour l'afficher à l'utilisateur).
pub fn ask_with_retry(req: &AiRequest, timeout: Duration, on_wait: &mut dyn FnMut(u64)) -> Result<String, String> {
    let mut attempt: u32 = 0;
    loop {
        match call_once(req, timeout) {
            Ok(text) => return Ok(text),
            Err(CallError::Status { provider, code, body, retry_after }) if (code == 429 || code == 503) && attempt < MAX_RETRIES => {
                let wait = retry_after.or_else(|| retry_delay(&body)).unwrap_or(15 * (u64::from(attempt) + 1));
                if wait > MAX_WAIT_SECS {
                    let hint = if wait > 600 { " Le quota du jour est probablement épuisé." } else { "" };
                    return Err(format!("{} Le fournisseur demande d'attendre environ {wait} s.{hint}", status_message_for(&provider, code, &body)));
                }
                on_wait(wait);
                std::thread::sleep(Duration::from_secs(wait));
                attempt += 1;
            }
            Err(e) => {
                let more = if attempt > 0 { format!(" (après {attempt} nouvel(s) essai(s) automatique(s))") } else { String::new() };
                return Err(format!("{}{more}", e.message()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn req(provider: &str, base: Option<String>) -> AiRequest {
        AiRequest {
            provider: provider.into(), model: "m1".into(), api_key: "SECRET".into(), system: "sys".into(),
            messages: vec![
                ChatMessage { role: "user".into(), content: "bonjour".into() },
                ChatMessage { role: "assistant".into(), content: "{}".into() },
                ChatMessage { role: "user".into(), content: "corrige".into() },
            ],
            base_url: base, max_tokens: None, num_ctx: None,
        }
    }

    /// Faux serveur HTTP : renvoie `status` + `body`, et transmet la requête reçue au test.
    fn serveur(status: u16, body: &'static str) -> (String, mpsc::Receiver<String>) {
        serveur_sequence(vec![(status, body, None)])
    }

    /// Faux serveur qui répond successivement (une connexion par réponse) ; `Some(n)` ajoute l'en-tête Retry-After.
    fn serveur_sequence(reponses: Vec<(u16, &'static str, Option<u64>)>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").map(Some).unwrap_or(None);
        let Some(listener) = listener else { return (String::new(), mpsc::channel().1) };
        let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
          for (status, body, retry_after) in reponses {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    buf.extend_from_slice(chunk.get(..n).unwrap_or(&[]));
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let len = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if rest.len() >= len { break; }
                    }
                    if n == 0 { break; }
                }
                let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
                let ra = retry_after.map(|n| format!("retry-after: {n}\r\n")).unwrap_or_default();
                let reponse = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{ra}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(reponse.as_bytes());
            }
          }
        });
        (format!("http://{addr}"), rx)
    }

    #[test]
    fn requetes_construites_pour_les_trois_fournisseurs() {
        let a = build_call(&req("anthropic", None)).map(|c| (c.url, c.headers, c.body)).unwrap_or_default();
        assert_eq!(a.0, "https://api.anthropic.com/v1/messages");
        assert!(a.1.iter().any(|(k, v)| k == "x-api-key" && v == "SECRET"));
        assert_eq!(a.2["system"], "sys");
        assert_eq!(a.2["messages"].as_array().map(Vec::len), Some(3));
        let o = build_call(&req("openai", None)).map(|c| (c.url, c.body)).unwrap_or_default();
        assert_eq!(o.0, "https://api.openai.com/v1/chat/completions");
        assert_eq!(o.1["messages"][0]["role"], "system");
        assert_eq!(o.1["messages"].as_array().map(Vec::len), Some(4));
        let g = build_call(&req("gemini", None)).map(|c| (c.url, c.headers, c.body)).unwrap_or_default();
        assert_eq!(g.0, "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent");
        assert!(g.1.iter().any(|(k, _)| k == "x-goog-api-key"));
        assert_eq!(g.2["contents"][1]["role"], "model");
        assert_eq!(g.2["systemInstruction"]["parts"][0]["text"], "sys");
    }

    #[test]
    fn refus_propres() {
        assert!(build_call(&req("inconnu", None)).is_err());
        let mut r = req("openai", None); r.api_key = "  ".into();
        assert!(build_call(&r).unwrap_err_or_default().contains("Clé API manquante"));
        let mut r = req("openai", None); r.messages.clear();
        assert!(build_call(&r).is_err());
    }

    trait ErrText { fn unwrap_err_or_default(self) -> String; }
    impl ErrText for Result<HttpCall, String> { fn unwrap_err_or_default(self) -> String { self.err().unwrap_or_default() } }

    #[test]
    fn lecture_des_reponses() {
        assert_eq!(parse_response("anthropic", &json!({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]})).unwrap_or_default(), "ab");
        assert_eq!(parse_response("openai", &json!({"choices": [{"message": {"content": "x"}}]})).unwrap_or_default(), "x");
        assert_eq!(parse_response("gemini", &json!({"candidates": [{"content": {"parts": [{"text": "y"}]}}]})).unwrap_or_default(), "y");
        assert!(parse_response("openai", &json!({"choices": []})).is_err());
        assert!(parse_response("gemini", &json!({"promptFeedback": {"blockReason": "SAFETY"}})).is_err());
    }

    #[test]
    fn messages_d_erreur_lisibles() {
        assert!(status_message(401, r#"{"error":{"message":"bad key"}}"#).contains("Clé API refusée"));
        assert!(status_message(429, "{}").contains("Quota"));
        assert!(status_message(404, "texte brut").contains("Modèle introuvable"));
        assert!(status_message(503, "").contains("indisponible"));
        assert!(status_message(400, r#"{"error":{"message":"trop long"}}"#).contains("trop long"));
    }

    #[test]
    fn dialogue_complet_avec_un_faux_serveur() {
        for (prov, corps, attendu) in [
            ("anthropic", r#"{"content":[{"type":"text","text":"réponse A"}]}"#, "réponse A"),
            ("openai", r#"{"choices":[{"message":{"content":"réponse O"}}]}"#, "réponse O"),
            ("gemini", r#"{"candidates":[{"content":{"parts":[{"text":"réponse G"}]}}]}"#, "réponse G"),
        ] {
            let (base, rx) = serveur(200, corps);
            let r = ask(&req(prov, Some(base)), Duration::from_secs(5));
            assert_eq!(r.unwrap_or_default(), attendu, "{prov}");
            let recu = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default().to_lowercase();
            assert!(recu.contains("secret"), "la clé est bien envoyée ({prov})");
            assert!(recu.contains("corrige"), "le corps contient les messages ({prov})");
        }
    }

    #[test]
    fn ollama_requete_sans_cle_avec_contexte_dimensionne() {
        let mut r = req("ollama", None); r.api_key = String::new(); r.model = "qwen2.5:7b".into();
        let c = build_call(&r).unwrap_or(HttpCall { url: String::new(), headers: vec![], body: json!({}) });
        assert_eq!(c.url, "http://localhost:11434/api/chat");
        assert!(c.headers.is_empty(), "aucune clé envoyée");
        assert_eq!(c.body["stream"], false); assert_eq!(c.body["format"], "json");
        assert_eq!(c.body["options"]["num_ctx"], 16384, "contexte par défaut, bien plus grand que les 4096 d'Ollama");
        assert_eq!(c.body["messages"][0]["role"], "system");
        // un gros catalogue agrandit le contexte au lieu d'être tronqué en silence
        let mut gros = req("ollama", Some("http://127.0.0.1:1234/".into())); gros.api_key = String::new();
        gros.messages = vec![ChatMessage { role: "user".into(), content: "x".repeat(90_000) }];
        let g = build_call(&gros).unwrap_or(HttpCall { url: String::new(), headers: vec![], body: json!({}) });
        assert_eq!(g.url, "http://127.0.0.1:1234/api/chat");
        let n = g.body["options"]["num_ctx"].as_u64().unwrap_or(0);
        assert!(n >= 30_000 + 512 && n % 1024 == 0 && n <= u64::from(OLLAMA_MAX_CTX), "{n}");
        // trop gros même pour le maximum : refus explicite
        gros.messages = vec![ChatMessage { role: "user".into(), content: "x".repeat(400_000) }];
        assert!(build_call(&gros).err().unwrap_or_default().contains("trop grosse"));
    }

    #[test]
    fn ollama_dialogue_et_erreurs_parlantes() {
        let (base, rx) = serveur(200, r#"{"message":{"role":"assistant","content":"réponse L"},"done":true}"#);
        let mut r = req("ollama", Some(base)); r.api_key = String::new();
        assert_eq!(ask(&r, Duration::from_secs(5)).unwrap_or_default(), "réponse L");
        let recu = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default().to_lowercase();
        assert!(recu.contains("/api/chat") && recu.contains("corrige") && !recu.contains("authorization"));
        let (b404, _rx) = serveur(404, r#"{"error":"model 'zzz' not found"}"#);
        let mut r2 = req("ollama", Some(b404)); r2.api_key = String::new();
        let e = ask(&r2, Duration::from_secs(5)).err().unwrap_or_default();
        assert!(e.contains("ollama pull") && e.contains("not found"), "{e}");
        let mut r3 = req("ollama", Some("http://127.0.0.1:9".into())); r3.api_key = String::new();
        let e3 = ask(&r3, Duration::from_secs(2)).err().unwrap_or_default();
        assert!(e3.contains("Ollama ne répond pas") && e3.contains("ollama serve"), "{e3}");
        assert_eq!(parse_response("ollama", &json!({"message": {"content": ""}})).is_err(), true);
    }

    #[test]
    fn delai_demande_par_le_fournisseur() {
        assert_eq!(retry_delay(r#"{"error":{"code":429,"details":[{"@type":"x"},{"retryDelay":"34s"}]}}"#), Some(34));
        assert_eq!(retry_delay(r#"{"error":{"message":"Quota exceeded. Please retry in 12.3s."}}"#), Some(13));
        assert_eq!(retry_delay("rien"), None);
        assert_eq!(retry_delay(r#"{"error":{"details":[{"retryDelay":"86400s"}]}}"#), Some(86400));
    }

    #[test]
    fn limite_par_minute_attend_puis_reussit() {
        let (base, _rx) = serveur_sequence(vec![
            (429, r#"{"error":{"message":"trop vite"}}"#, Some(1)),
            (200, r#"{"choices":[{"message":{"content":"enfin"}}]}"#, None),
        ]);
        let mut attentes = Vec::new();
        let r = ask_with_retry(&req("openai", Some(base)), Duration::from_secs(5), &mut |s| attentes.push(s));
        assert_eq!(r.unwrap_or_default(), "enfin");
        assert_eq!(attentes, vec![1]);
    }

    #[test]
    fn plusieurs_refus_puis_abandon_avec_message() {
        let (base, _rx) = serveur_sequence(vec![
            (429, "{}", Some(1)), (429, "{}", Some(1)), (429, r#"{"error":{"message":"encore"}}"#, Some(1)),
        ]);
        let mut n = 0;
        let e = ask_with_retry(&req("gemini", Some(base)), Duration::from_secs(5), &mut |_| n += 1).err().unwrap_or_default();
        assert_eq!(n, 2, "deux nouveaux essais seulement");
        assert!(e.contains("Quota") && e.contains("2 nouvel"), "{e}");
    }

    #[test]
    fn quota_du_jour_pas_d_attente_inutile() {
        let (base, _rx) = serveur(429, r#"{"error":{"details":[{"retryDelay":"7200s"}]}}"#);
        let mut attendu = false;
        let t0 = std::time::Instant::now();
        let e = ask_with_retry(&req("gemini", Some(base)), Duration::from_secs(5), &mut |_| attendu = true).err().unwrap_or_default();
        assert!(!attendu && t0.elapsed() < Duration::from_secs(3));
        assert!(e.contains("7200") && e.contains("quota du jour"), "{e}");
    }

    #[test]
    fn cle_refusee_jamais_reessayee() {
        let (base, _rx) = serveur(401, r#"{"error":{"message":"bad key"}}"#);
        let mut attendu = false;
        let e = ask_with_retry(&req("anthropic", Some(base)), Duration::from_secs(5), &mut |_| attendu = true).err().unwrap_or_default();
        assert!(!attendu && e.contains("Clé API refusée"), "{e}");
    }

    #[test]
    fn erreur_http_et_serveur_absent() {
        let (base, _rx) = serveur(429, r#"{"error":{"message":"limite"}}"#);
        let e = ask(&req("openai", Some(base)), Duration::from_secs(5)).err().unwrap_or_default();
        assert!(e.contains("Quota") && e.contains("limite"), "{e}");
        let e2 = ask(&req("openai", Some("http://127.0.0.1:9".into())), Duration::from_secs(2)).err().unwrap_or_default();
        assert!(e2.contains("Connexion"), "{e2}");
        assert!(!e2.contains("SECRET") && !e.contains("SECRET"), "la clé n'apparaît jamais dans les erreurs");
    }
}
