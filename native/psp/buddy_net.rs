//! Fixed-endpoint PSP Buddy transport.
//!
//! This is intentionally smaller than a general guest networking surface: it
//! discovers the saved PSP-Buddy profile, connects through the PSP OS, and
//! returns at most 4 KiB from Gilbert's local HTTP endpoint.
//!
//! ALLOCATION CONTRACT: the PocketJS PSP host has ONE global allocator
//! (hosts/psp/src/arena.rs) and it is deliberately single-threaded — the
//! QuickJS worker is documented as the only thread that may touch it. This
//! poller runs on its own thread, so it must never call into Rust's global
//! allocator. Every byte it produces lives in the fixed `Body` buffer below,
//! which is copied into a static cache and handed to the worker as bytes.
//! Violating this corrupts the arena's free lists and exhausts the heap after
//! a few minutes, which is what the "out of memory" crash on device was.

use alloc::string::String;
use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use psp::sys::{self, ApctlState, HttpMethod, NetModule, NetParam, ThreadAttributes, UtilityNetData};

const MAX_BODY: usize = 4096;
const POLL_US: u32 = 10_000_000;
const PROFILE_SSID: &[u8] = b"PSP-Buddy";
const URL: &[u8] = b"http://10.42.42.1/v1/buddy\0";

static mut READY: bool = false;
static POLLER_STARTED: AtomicBool = AtomicBool::new(false);
static CACHE_LOCK: AtomicBool = AtomicBool::new(false);
static CACHE_LEN: AtomicUsize = AtomicUsize::new(0);
static mut CACHE: [u8; MAX_BODY] = [0; MAX_BODY];
/// Whether the cache currently holds a SUCCESSFUL response.
///
/// A failed poll must not replace a good body with the offline stub: doing
/// so wiped every model from the screen the moment one request timed out,
/// and the tank read "NO MODELS REPORTING" while the bridge was healthy.
/// The last good body is kept instead, and the app's own staleness window
/// is what eventually ages it out.
static HAVE_GOOD: AtomicBool = AtomicBool::new(false);

/// A fixed-capacity byte buffer. No allocator involvement: it lives on the
/// poller's stack and is copied into the static cache when published.
struct Body {
    bytes: [u8; MAX_BODY],
    len: usize,
}

impl Body {
    const fn new() -> Self {
        Self {
            bytes: [0; MAX_BODY],
            len: 0,
        }
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }

    /// Append bytes. Returns false when the buffer is full.
    fn push(&mut self, value: &[u8]) -> bool {
        let end = match self.len.checked_add(value.len()) {
            Some(end) => end,
            None => return false,
        };
        if end > MAX_BODY {
            return false;
        }
        self.bytes[self.len..end].copy_from_slice(value);
        self.len = end;
        true
    }
}

pub unsafe fn load_modules() {
    // sceUtilityLoadNetModule must run on the EBOOT's original main thread,
    // before PocketJS moves the guest to its large-stack worker. The rust-psp
    // NetModule enum omits PSP_NET_MODULE_PARSEHTTP (5), so its NetHttp (5)
    // and NetSsl (6) variants load PARSEHTTP and HTTP respectively. Plain
    // Buddy HTTP does not need the real SSL module (7).
    let _ = sys::sceUtilityLoadNetModule(NetModule::NetCommon);
    let _ = sys::sceUtilityLoadNetModule(NetModule::NetInet);
    let _ = sys::sceUtilityLoadNetModule(NetModule::NetParseUri);
    let _ = sys::sceUtilityLoadNetModule(NetModule::NetHttp);
    let _ = sys::sceUtilityLoadNetModule(NetModule::NetSsl);
    start_poller();
}

fn lock_cache() {
    while CACHE_LOCK
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        core::hint::spin_loop();
    }
}

fn unlock_cache() {
    CACHE_LOCK.store(false, Ordering::Release);
}

/// Publish the poller's latest bytes into the static cache. Called on the
/// poller thread; copies only, never allocates.
unsafe fn publish(bytes: &[u8]) {
    let len = bytes.len().min(MAX_BODY);
    lock_cache();
    CACHE[..len].copy_from_slice(&bytes[..len]);
    CACHE_LEN.store(len, Ordering::Release);
    unlock_cache();
}

/// A copy of the cached bytes. Called on the QuickJS worker thread, where
/// allocating is safe (it is the arena's owner).
unsafe fn cached() -> String {
    lock_cache();
    let len = CACHE_LEN.load(Ordering::Acquire).min(MAX_BODY);
    let bytes = CACHE[..len].to_vec();
    unlock_cache();
    if bytes.is_empty() {
        String::from(
            "{\"version\":1,\"mode\":\"offline\",\"message\":\"WIFI STARTING 00000000\",\"sessionRemaining\":0,\"weeklyRemaining\":0,\"wakesAt\":0,\"sampledAt\":0}",
        )
    } else {
        String::from_utf8(bytes).unwrap_or_else(|_| {
            String::from(
                "{\"version\":1,\"mode\":\"offline\",\"message\":\"WIFI CACHE UTF8 FFFFFFFF\",\"sessionRemaining\":0,\"weeklyRemaining\":0,\"wakesAt\":0,\"sampledAt\":0}",
            )
        })
    }
}

unsafe extern "C" fn poller_thread(_args: usize, _argp: *mut c_void) -> i32 {
    loop {
        let (value, ok) = match init() {
            Ok(()) => match request() {
                Ok(body) => (body, true),
                Err(stage) => (offline(stage, -1), false),
            },
            Err((stage, code)) => (offline(stage, code), false),
        };
        // A failed poll must NOT replace a good body with the offline stub:
        // doing so wiped every model from the screen the moment one request
        // timed out, and the tank read "NO MODELS REPORTING" while the
        // bridge was healthy. The last good body is kept instead; the app's
        // own staleness window is what eventually ages it out.
        //
        // Before the first success, the offline stub is published so the
        // screen shows WHICH stage the connection is stuck at.
        if ok || !HAVE_GOOD.load(Ordering::Acquire) {
            publish(value.as_slice());
        }
        if ok {
            HAVE_GOOD.store(true, Ordering::Release);
        }
        sys::sceKernelDelayThread(POLL_US);
    }
}

unsafe fn start_poller() {
    if POLLER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let id = sys::sceKernelCreateThread(
        b"psp_buddy_net\0".as_ptr(),
        poller_thread,
        40,
        96 * 1024,
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 < 0 || sys::sceKernelStartThread(id, 0, core::ptr::null_mut()) < 0 {
        POLLER_STARTED.store(false, Ordering::Release);
    }
}

/// The offline payload, assembled by hand so the poller never allocates.
fn offline(stage: &str, code: i32) -> Body {
    const PREFIX: &[u8] = b"{\"version\":1,\"mode\":\"offline\",\"message\":\"WIFI ";
    const SUFFIX: &[u8] =
        b"\",\"sessionRemaining\":0,\"weeklyRemaining\":0,\"wakesAt\":0,\"sampledAt\":0}";
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    let mut body = Body::new();
    body.push(PREFIX);
    body.push(stage.as_bytes());
    body.push(b" ");
    let value = code as u32;
    let mut hex = [0u8; 8];
    for i in 0..8 {
        hex[7 - i] = HEX[((value >> (4 * i)) & 0xf) as usize];
    }
    body.push(&hex);
    body.push(SUFFIX);
    body
}

unsafe fn find_profile() -> Option<i32> {
    for id in 1..=32 {
        if sys::sceUtilityCheckNetParam(id) < 0 {
            continue;
        }
        let mut data = UtilityNetData { as_string: [0; 128] };
        if sys::sceUtilityGetNetParam(id, NetParam::Ssid, &mut data) < 0 {
            continue;
        }
        let ssid = data.as_string;
        let len = ssid.iter().position(|byte| *byte == 0).unwrap_or(ssid.len());
        if &ssid[..len] == PROFILE_SSID {
            return Some(id);
        }
    }
    None
}

unsafe fn init() -> Result<(), (&'static str, i32)> {
    if READY {
        let mut state = ApctlState::Disconnected;
        if sys::sceNetApctlGetState(&mut state) >= 0 && matches!(state, ApctlState::GotIp) {
            return Ok(());
        }
        // Suspend drops the access-point association but leaves the PSP's Net,
        // Inet, Apctl, and HTTP libraries initialized. Re-running their init
        // functions after wake returns 0x80410201 (already initialized). Keep
        // the stack and reconnect only the saved profile instead.
        let _ = sys::sceNetApctlDisconnect();
        sys::sceKernelDelayThread(100_000);
        let profile = find_profile().ok_or(("PROFILE MISSING", -1))?;
        let result = sys::sceNetApctlConnect(profile);
        if result < 0 {
            return Err(("RECONNECT", result));
        }
        for _ in 0..150 {
            let mut state = ApctlState::Disconnected;
            if sys::sceNetApctlGetState(&mut state) >= 0 && matches!(state, ApctlState::GotIp) {
                return Ok(());
            }
            sys::sceKernelDelayThread(100_000);
        }
        return Err(("RECONNECT TIMEOUT", -1));
    }

    let result = sys::sceNetInit(128 * 1024, 42, 0, 42, 0);
    if result < 0 {
        return Err(("NET INIT", result));
    }
    let result = sys::sceNetInetInit();
    if result < 0 {
        return Err(("INET INIT", result));
    }
    let result = sys::sceNetApctlInit(0x8000, 48);
    if result < 0 {
        return Err(("AP INIT", result));
    }

    let profile = find_profile().ok_or(("PROFILE MISSING", -1))?;
    let result = sys::sceNetApctlConnect(profile);
    if result < 0 {
        return Err(("CONNECT", result));
    }
    for _ in 0..150 {
        let mut state = ApctlState::Disconnected;
        if sys::sceNetApctlGetState(&mut state) >= 0 && matches!(state, ApctlState::GotIp) {
            let result = sys::sceHttpInit(20_000);
            if result < 0 {
                return Err(("HTTP INIT", result));
            }
            READY = true;
            return Ok(());
        }
        sys::sceKernelDelayThread(100_000);
    }
    Err(("CONNECT TIMEOUT", -1))
}

/// Fetch the Buddy payload into a stack buffer. No allocation happens here
/// or in anything it calls.
unsafe fn request() -> Result<Body, &'static str> {
    let mut agent = *b"PSPBuddy/1.0\0";
    let template = sys::sceHttpCreateTemplate(agent.as_mut_ptr(), 1, 0);
    if template < 0 {
        return Err("HTTP TEMPLATE");
    }

    let connection = sys::sceHttpCreateConnectionWithURL(template, URL.as_ptr(), 0);
    if connection < 0 {
        sys::sceHttpDeleteTemplate(template);
        return Err("HTTP CONNECTION");
    }
    sys::sceHttpSetConnectTimeOut(connection, 5_000_000);
    sys::sceHttpSetSendTimeOut(connection, 5_000_000);
    sys::sceHttpSetRecvTimeOut(connection, 5_000_000);

    let request = sys::sceHttpCreateRequestWithURL(
        connection,
        HttpMethod::Get,
        URL.as_ptr() as *mut u8,
        0,
    );
    if request < 0 {
        sys::sceHttpDeleteConnection(connection);
        sys::sceHttpDeleteTemplate(template);
        return Err("HTTP REQUEST");
    }

    let result = if sys::sceHttpSendRequest(request, core::ptr::null_mut(), 0) < 0 {
        Err("HTTP SEND")
    } else {
        let mut status = 0;
        if sys::sceHttpGetStatusCode(request, &mut status) < 0 || status != 200 {
            Err("HTTP STATUS")
        } else {
            let mut body = Body::new();
            let mut chunk = [0u8; 256];
            loop {
                let read = sys::sceHttpReadData(
                    request,
                    chunk.as_mut_ptr() as *mut c_void,
                    chunk.len() as u32,
                );
                if read < 0 {
                    break Err("HTTP READ");
                }
                if read == 0 {
                    if core::str::from_utf8(body.as_slice()).is_err() {
                        break Err("HTTP UTF8");
                    }
                    break Ok(body);
                }
                let read = read as usize;
                if !body.push(&chunk[..read]) {
                    break Err("HTTP TOO LARGE");
                }
            }
        }
    };

    sys::sceHttpDeleteRequest(request);
    sys::sceHttpDeleteConnection(connection);
    sys::sceHttpDeleteTemplate(template);
    result
}

pub unsafe fn snapshot() -> String {
    // Never perform network I/O on the QuickJS/render worker. A wedged PSP
    // HTTP request used to freeze JS movement and telemetry while native
    // sprite atlas playback kept animating, producing an animated creature
    // stuck in one spot. The poller owns networking; this is a bounded copy.
    start_poller();
    cached()
}
