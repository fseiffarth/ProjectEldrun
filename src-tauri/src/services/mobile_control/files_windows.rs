//! Windows counterpart of the Unix `ProjectDir`: no path-based child I/O.
//! `NtCreateFile` resolves exactly one name relative to a held directory,
//! opening the reparse point itself; handle metadata then rejects every
//! reparse type, including junctions. A renamed parent cannot redirect the
//! rest of a read or listing. Unsupported native operations fail closed.

use std::{
    fs,
    mem::{offset_of, size_of},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
};

use ::windows::{
    core::{HRESULT, PWSTR},
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
    },
    Win32::{
        Foundation::{ERROR_NO_MORE_FILES, HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING},
        Storage::FileSystem::{
            FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO, FILE_READ_ATTRIBUTES,
            FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use super::{canonical_root, valid_rel, valid_segment, FilesError};

pub(super) struct ProjectDir(fs::File);

impl ProjectDir {
    pub(super) fn open(root: &Path, rel: &str) -> Result<Self, FilesError> {
        let root = canonical_root(root)?;
        if !valid_rel(rel) {
            return Err(FilesError::NotFound);
        }
        // Only the configured root is opened by path. Reparse points in its
        // project-controlled leaf are refused, including a replacement after
        // canonicalization. Every operation below it starts from this handle.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
            .open(root)
            .map_err(|_| FilesError::Unavailable)?;
        plain_metadata(&file)
            .filter(fs::Metadata::is_dir)
            .ok_or(FilesError::Unavailable)?;
        let mut dir = Self(file);
        if !rel.is_empty() {
            for name in rel.split('/') {
                dir = dir.child_dir(name).ok_or(FilesError::NotFound)?;
            }
        }
        Ok(dir)
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    fn open_at(&self, name: &str, directory: bool) -> Option<fs::File> {
        // Do not let a caller turn the single native name into a multi-step
        // path, an absolute/device path, or an alternate data stream.
        if !valid_segment(name) {
            return None;
        }
        let mut name: Vec<u16> = name.encode_utf16().collect();
        let length = u16::try_from(name.len().checked_mul(2)?).ok()?;
        let unicode = UNICODE_STRING {
            Length: length,
            MaximumLength: length,
            Buffer: PWSTR(name.as_mut_ptr()),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: self.handle(),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut handle = HANDLE::default();
        let mut status = IO_STATUS_BLOCK::default();
        let kind = if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
        // SAFETY: all structures and the UTF-16 buffer remain live during the
        // synchronous call; RootDirectory is our live directory handle. FILE_OPEN
        // never creates anything. A single component plus OPEN_REPARSE_POINT
        // ensures the kernel cannot traverse a substituted junction or link.
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                &attributes,
                &mut status,
                None,
                Default::default(),
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                kind | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                None,
                0,
            )
        };
        if result.0 < 0 {
            return None;
        }
        // SAFETY: the successful open returned a fresh handle owned only here.
        let file = unsafe { fs::File::from_raw_handle(handle.0) };
        let meta = plain_metadata(&file)?;
        (if directory {
            meta.is_dir()
        } else {
            meta.is_file()
        })
        .then_some(file)
    }

    pub(super) fn child_dir(&self, name: &str) -> Option<Self> {
        self.open_at(name, true).map(Self)
    }

    pub(super) fn child_dir_meta(&self, name: &str) -> Option<fs::Metadata> {
        plain_metadata(&self.child_dir(name)?.0)
    }

    pub(super) fn open_file(&self, name: &str) -> Option<(fs::File, fs::Metadata)> {
        let file = self.open_at(name, false)?;
        let meta = plain_metadata(&file)?;
        meta.is_file().then_some((file, meta))
    }

    pub(super) fn entries(&self) -> Result<Vec<(String, bool)>, FilesError> {
        // u64 storage aligns the native records; 64 KiB fits even the longest
        // filesystem name. Enumeration uses this directory handle, never its
        // former path, and a fresh enumeration starts at the first entry.
        let mut buffer = vec![0u64; 8192];
        let bytes = buffer.len() * size_of::<u64>();
        let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let mut restart = true;
        let mut entries = Vec::new();
        loop {
            buffer.fill(0);
            let class = if restart {
                FileIdBothDirectoryRestartInfo
            } else {
                FileIdBothDirectoryInfo
            };
            // SAFETY: a live directory handle and a suitably aligned writable
            // allocation, with its exact byte length.
            let result = unsafe {
                GetFileInformationByHandleEx(
                    self.handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    bytes as u32,
                )
            };
            if let Err(error) = result {
                if error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                    return Ok(entries);
                }
                return Err(FilesError::Io(error.to_string()));
            }
            restart = false;
            let mut offset = 0usize;
            loop {
                let invalid = || FilesError::Io("Invalid directory record".to_owned());
                if offset > bytes - size_of::<FILE_ID_BOTH_DIR_INFO>() {
                    return Err(invalid());
                }
                // SAFETY: bounds checked above; unaligned reading also handles
                // any unusual native record packing without forming a reference.
                let record = unsafe {
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_ID_BOTH_DIR_INFO>()
                        .read_unaligned()
                };
                let length = record.FileNameLength as usize;
                let end = offset
                    .checked_add(name_offset)
                    .and_then(|v| v.checked_add(length))
                    .ok_or_else(invalid)?;
                if !length.is_multiple_of(2) || end > bytes || !offset.is_multiple_of(2) {
                    return Err(invalid());
                }
                if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0 {
                    // SAFETY: the UTF-16 slice lies within the allocation and
                    // starts at a u16-aligned offset, checked above.
                    let name = unsafe {
                        std::slice::from_raw_parts(
                            buffer
                                .as_ptr()
                                .cast::<u8>()
                                .add(offset + name_offset)
                                .cast::<u16>(),
                            length / 2,
                        )
                    };
                    if let Ok(name) = String::from_utf16(name) {
                        if valid_segment(&name) {
                            entries.push((
                                name,
                                record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
                            ));
                        }
                    }
                }
                if record.NextEntryOffset == 0 {
                    break;
                }
                let next = offset
                    .checked_add(record.NextEntryOffset as usize)
                    .ok_or_else(invalid)?;
                if next < end {
                    return Err(invalid());
                }
                offset = next;
            }
        }
    }
}

fn plain_metadata(file: &fs::File) -> Option<fs::Metadata> {
    file.metadata()
        .ok()
        .filter(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}
