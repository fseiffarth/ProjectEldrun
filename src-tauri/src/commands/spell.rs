//! Dictionary spell-check commands (`services::spell`) — the deterministic,
//! model-free provider beside `commands::ollama::check_grammar`. Local only:
//! nothing here reaches any network; the dictionaries are files on this
//! machine. Issues reuse `GrammarIssue`, the LLM provider's wire shape, so the
//! frontend resolver and overlay serve both providers unchanged.

use crate::commands::ollama::GrammarIssue;
use crate::services::spell;

/// Check `text` against the Hunspell dictionary for `language` (a code like
/// `en_US`; empty picks the default — an English variant when installed).
/// `doc` is the editor's highlight language (`"tex"`/`"markdown"`/…) and only
/// selects the prose masking. Errors are strings; `no_dictionary` is the token
/// the frontend renders as "install a dictionary".
#[tauri::command]
pub async fn spell_check(
    text: String,
    language: String,
    doc: String,
) -> Result<Vec<GrammarIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || spell::check(&text, &language, &doc))
        .await
        .map_err(|e| format!("spell task failed: {e}"))?
        .map(|issues| {
            issues
                .into_iter()
                .map(|i| GrammarIssue {
                    line: i.line,
                    bad: i.bad,
                    suggestion: i.suggestion,
                    category: "spelling".into(),
                    // No prose message: the backend writes no display text, so
                    // nothing here needs translating. The category + suggestion
                    // carry the tooltip.
                    message: String::new(),
                })
                .collect()
        })
}

/// The installed dictionary language codes (system dirs + the state dir's
/// `dictionaries/` folder), for the settings dropdown.
#[tauri::command]
pub async fn spell_languages() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        spell::available_languages_in(&spell::dict_dirs())
    })
    .await
    .map_err(|e| format!("spell task failed: {e}"))
}

/// Add a word to the personal dictionary (append-only
/// `<state_dir>/dictionaries/personal.dic`, folded into every language).
#[tauri::command]
pub async fn spell_add_word(word: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || spell::add_personal_word(&word))
        .await
        .map_err(|e| format!("spell task failed: {e}"))?
}
