//! The app's name — the ONE backend place it is spelled. Display text and
//! user agents are built from these, so a rename edits this file and its
//! frontend twin `src/lib/brand.ts`, nothing else.

/// The name as shown to the user, as a literal: `concat!` needs one, so text
/// that must stay a `&'static str` is written
/// `concat!("Open ", crate::app_name!(), " first")`. Everything else reads
/// [`DISPLAY`].
#[macro_export]
macro_rules! app_name {
    () => {
        "Eldrun"
    };
}

/// The name as shown to the user.
pub const DISPLAY: &str = app_name!();

/// Lowercase form for file names, service names and protocol names.
pub const SLUG: &str = "eldrun";

/// Prefix of the app's environment variables.
pub const ENV_PREFIX: &str = "ELDRUN_";

/// `<Display>/<version>` — how the app names itself to a server.
pub fn user_agent() -> String {
    format!("{DISPLAY}/{}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_forms_agree() {
        assert_eq!(SLUG, DISPLAY.to_lowercase());
        assert_eq!(ENV_PREFIX, format!("{}_", SLUG.to_uppercase()));
    }
}
