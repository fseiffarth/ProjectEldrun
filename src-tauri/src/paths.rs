use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsKind {
    Windows,
    Macos,
    Unix,
}

impl OsKind {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Unix
        }
    }
}

pub fn home_dir() -> PathBuf {
    home_dir_for(OsKind::current(), |key| std::env::var(key).ok())
}

pub fn home_dir_string() -> String {
    home_dir().to_string_lossy().into_owned()
}

pub fn home_dir_for<F>(os: OsKind, mut env: F) -> PathBuf
where
    F: FnMut(&str) -> Option<String>,
{
    match os {
        OsKind::Windows => {
            if let Some(userprofile) = non_empty(env("USERPROFILE")) {
                return PathBuf::from(userprofile);
            }
            if let (Some(drive), Some(path)) =
                (non_empty(env("HOMEDRIVE")), non_empty(env("HOMEPATH")))
            {
                return PathBuf::from(format!("{drive}{path}"));
            }
            PathBuf::from(r"C:\Users\Default")
        }
        OsKind::Macos => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp")),
        OsKind::Unix => env("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/root")),
    }
}

pub fn projects_root() -> PathBuf {
    home_dir().join("eldrun").join("projects")
}

pub fn root_work_dir() -> PathBuf {
    home_dir().join("eldrun").join("root")
}

pub fn boxes_root() -> PathBuf {
    home_dir().join("eldrun").join("boxes")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env<'a>(values: &'a [(&str, &str)]) -> impl FnMut(&str) -> Option<String> + 'a {
        let map = values.iter().copied().collect::<HashMap<_, _>>();
        move |key| map.get(key).map(|value| (*value).to_string())
    }

    #[test]
    fn windows_home_prefers_userprofile() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[
                ("USERPROFILE", r"C:\Users\alice"),
                ("HOMEDRIVE", "D:"),
                ("HOMEPATH", r"\Users\bob"),
            ]),
        );
        assert_eq!(home, PathBuf::from(r"C:\Users\alice"));
    }

    #[test]
    fn windows_home_uses_homedrive_and_homepath() {
        let home = home_dir_for(
            OsKind::Windows,
            env(&[("HOMEDRIVE", "D:"), ("HOMEPATH", r"\Users\bob")]),
        );
        assert_eq!(home, PathBuf::from(r"D:\Users\bob"));
    }

    #[test]
    fn windows_home_has_stable_fallback() {
        let home = home_dir_for(OsKind::Windows, env(&[]));
        assert_eq!(home, PathBuf::from(r"C:\Users\Default"));
    }

    #[test]
    fn unix_home_uses_home() {
        let home = home_dir_for(OsKind::Unix, env(&[("HOME", "/home/alice")]));
        assert_eq!(home, PathBuf::from("/home/alice"));
    }

    #[test]
    fn unix_home_falls_back_to_root() {
        let home = home_dir_for(OsKind::Unix, env(&[]));
        assert_eq!(home, PathBuf::from("/root"));
    }

    #[test]
    fn boxes_root_ends_with_boxes_under_eldrun() {
        let dir = boxes_root();
        let last = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(last, "boxes", "boxes_root must end in 'boxes': {dir:?}");
        let parent = dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        assert_eq!(parent, "eldrun", "boxes_root parent must be 'eldrun'");
    }
}
