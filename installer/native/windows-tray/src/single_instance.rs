// Single-instance: ensures only one viewlba-tray.exe runs per Windows session.
//
// Uses a named kernel mutex (CreateMutexW) — when the second instance tries
// to acquire, Windows returns ERROR_ALREADY_EXISTS (183) without blocking.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Security::*;
use windows::Win32::Security::Authorization::*;
use windows::Win32::System::Threading::*;

pub struct SingleInstanceGuard {
    handle: HANDLE,
}

pub fn acquire(mutex_name: &str) -> Option<SingleInstanceGuard> {
    unsafe {
        let sddl: PCWSTR = w!("D:P(A;;0x100000;;;AU)");
        let mut sd_ptr: PSECURITY_DESCRIPTOR = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl,
            1, // SDDL_REVISION_1
            core::ptr::addr_of_mut!(sd_ptr),
            None,
        );
        let sa = if ok.is_ok() {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd_ptr.0,
                bInheritHandle: false.into(),
            }
        } else {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: false.into(),
            }
        };

        let name_wide: Vec<u16> = mutex_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let handle_result = CreateMutexW(
            Some(&sa),
            false,
            PCWSTR(name_wide.as_ptr()),
        );

        // CreateMutexW returns Result<HANDLE>
        let handle = match handle_result {
            Ok(h) if !h.is_invalid() => h,
            _ => return None,
        };

        let err = GetLastError();
        if err == ERROR_ALREADY_EXISTS {
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
