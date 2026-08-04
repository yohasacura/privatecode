//! Windows Job Object ownership for the agent sidecar.
//!
//! Its own file so the orphan test (`examples/orphan_check.rs`) exercises THIS code rather
//! than a copy of it — the property under test is one the OS provides, and a test against a
//! reimplementation of the setup would prove nothing about the app.

use std::process::Child;

/// A Windows Job Object holding the sidecar, created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
///
/// This is the only mechanism that survives the failure modes the graceful path cannot
/// cover. `shutdown_sidecar` closes stdin, waits, and falls back to `taskkill /T` — which
/// works when the app is closed normally, and does nothing at all in the two cases that
/// actually strand processes:
///
/// - **The app dies without running its shutdown** (crash, Task Manager, power loss on the
///   parent). Nothing runs `taskkill`, so the sidecar, its MCP servers and its browser all
///   keep running with no window attached to them.
/// - **The sidecar dies on its own** and its own children outlive it. `taskkill /T <pid>`
///   walks the tree from a live parent; once the parent is gone there is no tree left to
///   walk, and the orphans keep the browser profile locked so the next launch fails.
///
/// A job object is the OS answering both at once: children join their parent's job
/// automatically, and when the last handle to the job closes — explicitly on shutdown, or
/// by the kernel when this process dies for ANY reason — every process still in it is
/// terminated. That is the same guarantee the user's own `Start-QwenServer.ps1` relies on.
pub struct JobHandle(*mut std::ffi::c_void);

// The handle is an opaque kernel object, not a pointer into this process's memory; moving
// it between threads is exactly what the OS intends. Required because `RunningSidecar`
// lives behind a `Mutex` shared across Tauri's command threads.
unsafe impl Send for JobHandle {}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // Closing the last handle is what kills the job. This runs on a normal shutdown,
        // on a restart, and — via ordinary process teardown — if this process is killed.
        unsafe { winjob::CloseHandle(self.0) };
    }
}

mod winjob {
    use std::ffi::c_void;

    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    #[derive(Default)]
    pub struct IoCounters {
        pub read_operation_count: u64,
        pub write_operation_count: u64,
        pub other_operation_count: u64,
        pub read_transfer_count: u64,
        pub write_transfer_count: u64,
        pub other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct BasicLimitInformation {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct ExtendedLimitInformation {
        pub basic_limit_information: BasicLimitInformation,
        pub io_info: IoCounters,
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    // Declared here rather than pulled in with the `windows` crate: this is five functions
    // and three structs, against a dependency that would be the largest thing in a project
    // whose whole proposition is that it ships as a folder.
    extern "system" {
        pub fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }
}

/// Puts `child` in a kill-on-close job, or returns `None` if the OS refused.
///
/// Failure is deliberately soft. A job object is a backstop for cases that are already
/// abnormal; not getting one must not stop the app from starting, and the graceful shutdown
/// path is unaffected either way.
///
/// There is a window between `spawn()` and this call in which the sidecar could start a
/// process that would miss the job. It stays open for microseconds and the sidecar spawns
/// nothing until it receives an `init` request over stdin — which cannot happen before the
/// window exists. Closing it properly would mean `CREATE_SUSPENDED` plus `ResumeThread`,
/// and `std::process` exposes no thread handle to resume.
pub fn assign_to_job(child: &Child) -> Option<JobHandle> {
    use std::os::windows::io::AsRawHandle;

    unsafe {
        let job = winjob::CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info = winjob::ExtendedLimitInformation::default();
        info.basic_limit_information.limit_flags = winjob::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = winjob::SetInformationJobObject(
            job,
            winjob::JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            std::ptr::addr_of!(info).cast(),
            std::mem::size_of::<winjob::ExtendedLimitInformation>() as u32,
        );
        if set == 0 {
            winjob::CloseHandle(job);
            return None;
        }
        if winjob::AssignProcessToJobObject(job, child.as_raw_handle().cast()) == 0 {
            winjob::CloseHandle(job);
            return None;
        }
        Some(JobHandle(job))
    }
}
