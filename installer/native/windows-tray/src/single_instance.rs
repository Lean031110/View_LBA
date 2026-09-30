// Single-instance: ensures only one viewlba-tray.exe runs per Windows session.
//
// Uses a named kernel mutex (CreateMutexW) — when the second instance tries
// to acquire, Windows returns ERROR_ALREADY_EXISTS (183) without blocking.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Security::*;
use windows::Win32::System::Threading::*;

pub struct SingleInstanceGuard {
    handle: HANDLE,
}

pub fn acquire(mutex_name: &str) -> Option<SingleInstanceGuard> {
    unsafe {
        // Build a security descriptor that grants SYNCHRONIZE to Authenticated
        // Users so the second instance (running as the user) can detect us.
        // We use SDDL: D:P(A;;0x100000;;;AU) — protected DACL, Allow SYNCHRONIZE
        // to Authenticated Users.
        // This is read-only access (no GENERIC_ALL) — second instance can
        // OpenMutex but cannot release our mutex.
        let sddl: PCWSTR = w!("D:P(A;;0x100000;;;AU)");
        let mut sd_ptr: *mut c_void = std::ptr::null_mut();
        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl,
            SDDL_REVISION_1,
            &mut sd_ptr,
            None,
        );
        let sa = if ok.is_ok() {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd_ptr,
                bInheritHandle: false.into(),
            }
        } else {
            // Fallback: NULL SD = default ACL (less restrictive)
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: false.into(),
            }
        };

        // Convert mutex name to wide string
        let name_wide: Vec<u16> = mutex_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let handle = CreateMutexW(
            Some(&sa),
            false,
            PCWSTR(name_wide.as_ptr()),
        );

        // Free the SD if we allocated it
        if !sd_ptr.is_null() {
            let _ = LocalFree(Some(sd_ptr as *const _));
        }

        if handle.is_invalid() {
            // Failed to create mutex
            return None;
        }

        let err = GetLastError();
        if err == ERROR_ALREADY_EXISTS {
            // Another instance already owns this mutex
            let _ = CloseHandle(handle);
            return None;
        }

        Some(SingleInstanceGuard { handle })
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_invalid() {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}
