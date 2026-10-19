//! A probe owns its descendants even when its shell exits or the future is dropped.
use std::io;
use tokio::process::{Child, Command};

pub(super) struct ProcessTree {
    #[cfg(windows)]
    job: isize,
    #[cfg(unix)]
    group: Option<i32>,
    armed: bool,
}

impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let tree = Self {
                job: job as isize,
                armed: true,
            };
            tree.kill_on_close(true)?;
            Ok(tree)
        }
        #[cfg(unix)]
        {
            Ok(Self {
                group: None,
                armed: true,
            })
        }
    }

    pub fn configure(&self, command: &mut Command) {
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            // No profile/Python child can escape before the shell joins its job.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
    }

    pub fn attach(&mut self, child: &Child) -> io::Result<()> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
            let handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("probe has no process handle"))?;
            if unsafe { AssignProcessToJobObject(self.job as _, handle as _) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Self::resume(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("probe has no PID"))?,
            )?;
        }
        #[cfg(unix)]
        {
            self.group = child.id().map(|pid| pid as i32);
        }
        Ok(())
    }

    #[cfg(windows)]
    fn resume(pid: u32) -> io::Result<()> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::*,
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };
        // Tokio exposes the process handle but not CreateProcess's primary
        // thread handle. A suspended newborn has exactly one owned thread.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut found = unsafe { Thread32First(snapshot, &mut entry) };
            while found != 0 {
                if entry.th32OwnerProcessID == pid {
                    let thread =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let resumed = unsafe { ResumeThread(thread) };
                    let result = if resumed == u32::MAX {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(())
                    };
                    unsafe {
                        CloseHandle(thread);
                    }
                    return result;
                }
                found = unsafe { Thread32Next(snapshot, &mut entry) };
            }
            Err(io::Error::other("cannot find the suspended probe thread"))
        })();
        unsafe {
            CloseHandle(snapshot);
        }
        result
    }

    #[cfg(windows)]
    fn members(&self) -> io::Result<Vec<std::os::windows::io::OwnedHandle>> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, ERROR_MORE_DATA},
            System::{
                JobObjects::*,
                Threading::{OpenProcess, PROCESS_SYNCHRONIZE},
            },
        };
        let mut capacity = 64;
        while capacity <= 65536 {
            // usize storage provides the alignment required by the variable-size list.
            let mut buffer = vec![0usize; capacity + 2];
            let success = unsafe {
                QueryInformationJobObject(
                    self.job as _,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr() as _,
                    std::mem::size_of_val(buffer.as_slice()) as u32,
                    std::ptr::null_mut(),
                )
            };
            if success == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
                    capacity *= 2;
                    continue;
                }
                return Err(error);
            }
            let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            let count = list.NumberOfProcessIdsInList as usize;
            if count > capacity {
                capacity *= 2;
                continue;
            }
            let ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count) };
            let mut handles = Vec::new();
            for pid in ids {
                let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid as u32) };
                if handle.is_null() {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                        continue;
                    }
                    return Err(error);
                }
                handles.push(unsafe { OwnedHandle::from_raw_handle(handle as _) });
            }
            return Ok(handles);
        }
        Err(io::Error::other("too many probe processes to enumerate"))
    }

    #[cfg(windows)]
    fn kill_on_close(&self, enabled: bool) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        if enabled {
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        if unsafe {
            SetInformationJobObject(
                self.job as _,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub async fn stop(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            use windows_sys::Win32::{
                Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            let members = self.members();
            if unsafe { TerminateJobObject(self.job as _, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let members = members?;
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                    if unsafe {
                        QueryInformationJobObject(
                            self.job as _,
                            JobObjectBasicAccountingInformation,
                            &mut info as *mut _ as _,
                            std::mem::size_of_val(&info) as u32,
                            std::ptr::null_mut(),
                        )
                    } == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    // Job accounting can reach zero before process handles
                    // become signaled. Wait for actual exit before returning.
                    let mut exited = true;
                    for process in &members {
                        match unsafe { WaitForSingleObject(process.as_raw_handle() as _, 0) } {
                            WAIT_OBJECT_0 => {}
                            WAIT_TIMEOUT => exited = false,
                            _ => return Err(io::Error::last_os_error()),
                        }
                    }
                    if info.ActiveProcesses == 0 && exited {
                        return Ok(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "probe processes did not exit")
            })??;
        }
        #[cfg(unix)]
        if let Some(group) = self.group {
            if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub fn complete(&mut self) -> io::Result<()> {
        // Successful probes preserve normal profile side effects (e.g. an agent).
        #[cfg(windows)]
        self.kill_on_close(false)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            if self.armed {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1);
            }
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
        #[cfg(unix)]
        if self.armed {
            if let Some(group) = self.group {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
    }
}
