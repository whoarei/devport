use super::{error, Distribution, Result};
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, RPC_E_CHANGED_MODE},
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        Services::*,
        Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
    },
    UI::{
        Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_HIDE,
    },
};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
    RegKey,
};

pub(super) fn executable() -> Result<PathBuf> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .map_err(|e| error("not_installed", e))?;
    let folder: String = key
        .get_value("ProgramFilesDir")
        .map_err(|e| error("not_installed", e))?;
    let root = PathBuf::from(folder)
        .canonicalize()
        .map_err(|e| error("not_installed", e))?;
    let path = root
        .join("usbipd-win/usbipd.exe")
        .canonicalize()
        .map_err(|_| error("not_installed", "install usbipd-win 5.x in Program Files"))?;
    if !path.starts_with(&root) {
        return Err(error(
            "not_installed",
            "USB executable is outside Program Files",
        ));
    }
    Ok(crate::verbatim::simplify(&path))
}

pub(super) fn distributions() -> Result<Vec<Distribution>> {
    let root = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss")
        .map_err(|e| error("wsl_failed", e))?;
    let mut list = Vec::new();
    for name in root.enum_keys() {
        let key = root
            .open_subkey(name.map_err(|e| error("wsl_failed", e))?)
            .map_err(|e| error("wsl_failed", e))?;
        let name: String = key
            .get_value("DistributionName")
            .map_err(|e| error("wsl_failed", e))?;
        let version: u32 = key
            .get_value("Version")
            .map_err(|e| error("wsl_failed", e))?;
        list.push(Distribution { name, version });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

pub(super) fn service_ready() -> Result<()> {
    // Handles close on every path, including failures to query service state.
    unsafe {
        let manager = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            return Err(error("service_stopped", std::io::Error::last_os_error()));
        }
        let name: Vec<u16> = "usbipd\0".encode_utf16().collect();
        let service = OpenServiceW(manager, name.as_ptr(), SERVICE_QUERY_STATUS);
        if service.is_null() {
            let e = std::io::Error::last_os_error();
            CloseServiceHandle(manager);
            return Err(error("service_stopped", e));
        }
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0;
        let ok = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            std::mem::size_of_val(&status) as u32,
            &mut needed,
        );
        let e = std::io::Error::last_os_error();
        CloseServiceHandle(service);
        CloseServiceHandle(manager);
        if ok == 0 {
            return Err(error("service_stopped", e));
        }
        if status.dwCurrentState != SERVICE_RUNNING {
            return Err(error(
                "service_stopped",
                "USBIP Device Host service is not running",
            ));
        }
    }
    Ok(())
}

pub(super) fn elevate(path: &Path, payload: &str) -> Result<()> {
    if payload.is_empty()
        || payload.len() > 8192
        || !payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    {
        return Err(error("invalid_input", "invalid elevated USB payload"));
    }
    let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let args: Vec<u16> = format!("--usb-elevated {payload}\0")
        .encode_utf16()
        .collect();
    struct ComApartment(bool);
    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    unsafe {
        // ShellExecuteEx can invoke COM shell extensions on this worker thread.
        let initialized = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if initialized < 0 && initialized != RPC_E_CHANGED_MODE {
            return Err(error(
                "permission_denied",
                format!("COM initialization failed: {initialized:#x}"),
            ));
        }
        let _apartment = ComApartment(initialized >= 0);
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of_val(&info) as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = args.as_ptr();
        info.nShow = SW_HIDE;
        if ShellExecuteExW(&mut info) == 0 {
            let code = GetLastError();
            return Err(error(
                if code == ERROR_CANCELLED {
                    "uac_cancelled"
                } else {
                    "permission_denied"
                },
                std::io::Error::from_raw_os_error(code as i32),
            ));
        }
        if info.hProcess.is_null() {
            return Err(error(
                "command_failed",
                "elevated USB process returned no handle",
            ));
        }
        // UAC is user-controlled. Keep the operation lease until it really exits;
        // a timeout must not allow a second action to race an elevated process.
        let wait = WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1;
        let ok = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if wait != 0 || ok == 0 || code != 0 {
            return Err(error(
                if code == 3 {
                    "device_changed"
                } else {
                    "command_failed"
                },
                format!("elevated USB command exited with code {code}"),
            ));
        }
    }
    Ok(())
}
