//! Tauri commands for the Skills Library (`docs/skills_plan.md`). Thin wrappers
//! over `services::skills` — every filesystem/git op is offloaded to the
//! blocking pool since a Tauri command otherwise runs on the async runtime's
//! worker (a `git pull`/clone here is the same cost class as `git_clone`).

use crate::schema::skills::{InstalledSkill, SkillCatalogEntry, SkillDetail, SkillSource};
use crate::services::skills;

async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("skills task failed: {e}"))?
}

#[tauri::command]
pub async fn skills_list_sources() -> Result<Vec<SkillSource>, String> {
    run_off_thread(|| Ok(skills::list_sources())).await
}

#[tauri::command]
pub async fn skills_add_source(label: String, url: String) -> Result<SkillSource, String> {
    run_off_thread(move || skills::add_source(label, url)).await
}

#[tauri::command]
pub async fn skills_remove_source(id: String) -> Result<(), String> {
    run_off_thread(move || skills::remove_source(id)).await
}

#[tauri::command]
pub async fn skills_refresh_source(id: String) -> Result<(), String> {
    run_off_thread(move || skills::refresh_source(&id)).await
}

#[tauri::command]
pub async fn skills_list_catalog(source_id: String) -> Result<Vec<SkillCatalogEntry>, String> {
    run_off_thread(move || Ok(skills::list_catalog(&source_id))).await
}

#[tauri::command]
pub async fn skills_get_detail(source_id: String, rel_path: String) -> Result<SkillDetail, String> {
    run_off_thread(move || skills::get_skill_detail(&source_id, &rel_path)).await
}

#[tauri::command]
pub async fn skills_install(
    project_dir: String,
    source_id: String,
    rel_path: String,
) -> Result<(), String> {
    run_off_thread(move || skills::install_skill(&project_dir, &source_id, &rel_path)).await
}

#[tauri::command]
pub async fn skills_uninstall(project_dir: String, name: String) -> Result<(), String> {
    run_off_thread(move || skills::uninstall_skill(&project_dir, &name)).await
}

#[tauri::command]
pub async fn skills_list_installed(project_dir: String) -> Result<Vec<InstalledSkill>, String> {
    run_off_thread(move || Ok(skills::list_installed(&project_dir))).await
}
