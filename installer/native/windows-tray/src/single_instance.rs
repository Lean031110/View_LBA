// Single-instance: ensures only one viewlba-tray.exe runs per Windows session.
//
// Uses a named kernel mutex (CreateMutexW) — when the second instance tries
// to acquire, Windows returns ERROR_ALREADY_EXISTS (183) without blocking.

pub struct SingleInstanceGuard {
    handle: usize, // raw HANDLE
}

#[cfg(target_os = "windows")]
pub fn acquire(mutex_name: &str) -> Option<SingleInstanceGuard> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR};

    // Build a SD that grants SYNCHRONIZE to Authenticated Users so the second
    // instance (running as the user) can detect us.
    // For v1 simplicity, we use a NULL SD which means default ACL — the
    // LocalSystem + the creating user own it, and any user in the same session
    // can OpenMutex. This is sufficient for the single-instance check.

    let name_wide: Vec<u16> = mutex_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
    sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
    sa.bInheritHandle = 0;
    sa.lpSecurityDescriptor = std::ptr::null_mut();

    let handle = unsafe {
        CreateMutexW(&sa as *const _, 0, name_wide.as_ptr())
    };

    if handle == 0 || handle == INVALID_HANDLE_VALUE {
        // Failed to create the mutex — assume another instance exists
        return None;
    }

    let err = unsafe { GetLastError() };
    if err == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return None;
    }

    Some(SingleInstanceGuard { handle: handle as usize })
}

#[cfg(not(target_os = "windows"))]
pub fn acquire(_mutex_name: &str) -> Option<SingleInstanceGuard> {
    // Non-Windows: stub
    Some(SingleInstanceGuard { handle: 0 })
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if self.handle != 0 {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle as *mut _) };
            }
        }
    }
}
