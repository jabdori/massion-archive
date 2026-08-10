use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_INCOMING_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS: usize = 128;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const COMMAND_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CODEX_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CODEX_LOGIN_POLL: Duration = Duration::from_millis(200);
const BRIDGE_EVENT: &str = "massion://bridge-event";
const MAIN_WEBVIEW_LABEL: &str = "main";
const BUNDLED_FRONTEND_URL: &str = "tauri://localhost";

#[derive(Clone, Copy)]
enum BridgeMethod {
    Hello,
    Connect,
    Query,
    Command,
    EventsStart,
    EventsStop,
    ExecutionsStart,
    ExecutionsStop,
    Shutdown,
}

impl BridgeMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Hello => "hello",
            Self::Connect => "connect",
            Self::Query => "query",
            Self::Command => "command",
            Self::EventsStart => "events.start",
            Self::EventsStop => "events.stop",
            Self::ExecutionsStart => "executions.start",
            Self::ExecutionsStop => "executions.stop",
            Self::Shutdown => "shutdown",
        }
    }
}

fn response_timeout(method: BridgeMethod) -> Duration {
    match method {
        BridgeMethod::Connect => CONNECT_RESPONSE_TIMEOUT,
        BridgeMethod::Command => COMMAND_RESPONSE_TIMEOUT,
        _ => RESPONSE_TIMEOUT,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PublicError {
    code: String,
    message: String,
}

impl PublicError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}

impl fmt::Display for PublicError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for PublicError {}

#[derive(Clone, Debug, Deserialize)]
struct BridgeResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<PublicError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum StreamName {
    Events,
    Executions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PushEvent {
    stream: StreamName,
    payload: Value,
}

enum Incoming {
    Response(BridgeResponse),
    Event(PushEvent),
}

fn encode_request(id: &str, method: BridgeMethod, params: Value) -> Result<Vec<u8>, PublicError> {
    let mut encoded = serde_json::to_vec(&json!({
        "id": id,
        "method": method.as_str(),
        "params": params,
    }))
    .map_err(|_| PublicError::new("bridge_invalid_request", "요청을 직렬화하지 못했습니다"))?;
    if encoded.len() + 1 > MAX_REQUEST_BYTES {
        return Err(PublicError::new(
            "bridge_request_too_large",
            "요청 크기 상한을 초과했습니다",
        ));
    }
    encoded.push(b'\n');
    Ok(encoded)
}

fn parse_incoming(line: &[u8]) -> Result<Incoming, PublicError> {
    if line.len() > MAX_INCOMING_BYTES {
        return Err(PublicError::new(
            "bridge_response_too_large",
            "응답 크기 상한을 초과했습니다",
        ));
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| {
        PublicError::new(
            "bridge_invalid_response",
            "브릿지 응답 형식이 올바르지 않습니다",
        )
    })?;

    if value.get("type").and_then(Value::as_str) == Some("event") {
        let stream =
            serde_json::from_value(value.get("stream").cloned().ok_or_else(|| {
                PublicError::new("bridge_invalid_event", "이벤트 스트림이 없습니다")
            })?)
            .map_err(|_| {
                PublicError::new("bridge_invalid_event", "지원하지 않는 이벤트 스트림입니다")
            })?;
        return Ok(Incoming::Event(PushEvent {
            stream,
            payload: value.get("payload").cloned().unwrap_or(Value::Null),
        }));
    }

    let response: BridgeResponse = serde_json::from_value(value).map_err(|_| {
        PublicError::new(
            "bridge_invalid_response",
            "브릿지 응답 형식이 올바르지 않습니다",
        )
    })?;
    if response.id.is_empty() || (!response.ok && response.error.is_none()) {
        return Err(PublicError::new(
            "bridge_invalid_response",
            "브릿지 응답 필드가 올바르지 않습니다",
        ));
    }
    Ok(Incoming::Response(response))
}

#[derive(Default)]
struct ResponseRouter {
    pending: Mutex<HashMap<String, mpsc::Sender<BridgeResponse>>>,
}

impl ResponseRouter {
    fn register(&self, id: &str) -> Result<mpsc::Receiver<BridgeResponse>, PublicError> {
        let mut pending = self.pending.lock().map_err(|_| bridge_closed())?;
        if pending.len() >= MAX_PENDING_REQUESTS {
            return Err(PublicError::new(
                "bridge_busy",
                "동시 요청 상한을 초과했습니다",
            ));
        }
        let (sender, receiver) = mpsc::channel();
        pending.insert(id.to_owned(), sender);
        Ok(receiver)
    }

    fn dispatch(&self, incoming: Incoming) -> Result<Option<PushEvent>, PublicError> {
        match incoming {
            Incoming::Event(event) => Ok(Some(event)),
            Incoming::Response(response) => {
                let sender = self
                    .pending
                    .lock()
                    .map_err(|_| bridge_closed())?
                    .remove(&response.id);
                if let Some(sender) = sender {
                    let _ = sender.send(response);
                }
                Ok(None)
            }
        }
    }

    fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }

    fn fail_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}

fn bridge_closed() -> PublicError {
    PublicError::new("bridge_unavailable", "데스크톱 브릿지에 연결할 수 없습니다")
}

#[derive(Clone)]
struct RuntimePaths {
    node: PathBuf,
    bridge_entry: PathBuf,
    desktop_login_entry: PathBuf,
    server_entry: PathBuf,
    surrealdb: PathBuf,
    surreal_sha256: String,
    bundled_extensions: Option<PathBuf>,
}

impl RuntimePaths {
    fn development(
        manifest_dir: &Path,
        node: &Path,
        surrealdb: &Path,
    ) -> Result<Self, PublicError> {
        Ok(Self {
            node: required_file(node)?,
            bridge_entry: required_file(&manifest_dir.join("../../desktop-bridge/dist/entry.js"))?,
            desktop_login_entry: required_file(
                &manifest_dir.join("../../cli/dist/desktop-login.js"),
            )?,
            server_entry: required_file(&manifest_dir.join("../../server/dist/main.js"))?,
            surrealdb: required_file(surrealdb)?,
            surreal_sha256: pinned_surreal_sha256()?,
            bundled_extensions: None,
        })
    }

    fn bundled(executable_dir: &Path, resources: &Path) -> Result<Self, PublicError> {
        Ok(Self {
            node: required_file(&executable_dir.join("node"))?,
            bridge_entry: required_file(&resources.join("desktop-bridge/dist/entry.js"))?,
            desktop_login_entry: required_file(&resources.join("cli/dist/desktop-login.js"))?,
            server_entry: required_file(&resources.join("server/dist/main.js"))?,
            surrealdb: required_file(&executable_dir.join("surrealdb"))?,
            surreal_sha256: pinned_surreal_sha256()?,
            bundled_extensions: Some(resources.join("extensions")),
        })
    }

    fn child_environment(&self) -> HashMap<&'static str, OsString> {
        let mut environment = HashMap::from([
            (
                "MASSION_SERVER_BIN",
                self.server_entry.clone().into_os_string(),
            ),
            (
                "MASSION_SURREAL_BINARY",
                self.surrealdb.clone().into_os_string(),
            ),
            (
                "MASSION_SURREAL_SHA256",
                OsString::from(&self.surreal_sha256),
            ),
        ]);
        if let Some(root) = &self.bundled_extensions {
            environment.insert(
                "MASSION_REGISTRY_BUNDLED_EXTENSIONS",
                root.clone().into_os_string(),
            );
        }
        environment
    }

    fn discover(app: &tauri::AppHandle) -> Result<Self, PublicError> {
        if cfg!(debug_assertions) {
            let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
            return Self::development(
                manifest_dir,
                &find_executable("node")?,
                &development_surrealdb_sidecar(manifest_dir)?,
            );
        }

        let executable_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from))
            .ok_or_else(bridge_closed)?;
        let resources = app.path().resource_dir().map_err(|_| bridge_closed())?;
        Self::bundled(&executable_dir, &resources)
    }
}

fn development_surrealdb_sidecar(manifest_dir: &Path) -> Result<PathBuf, PublicError> {
    required_file(&manifest_dir.join("binaries/surrealdb-aarch64-apple-darwin"))
}

fn required_file(path: &Path) -> Result<PathBuf, PublicError> {
    let path = path.canonicalize().map_err(|_| bridge_closed())?;
    path.is_file().then_some(path).ok_or_else(bridge_closed)
}

fn find_executable(name: &str) -> Result<PathBuf, PublicError> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find_map(|path| required_file(&path).ok())
        .ok_or_else(bridge_closed)
}

fn pinned_surreal_sha256() -> Result<String, PublicError> {
    let manifest: Value = serde_json::from_str(include_str!("../runtime-manifest.json"))
        .map_err(|_| bridge_closed())?;
    let digest = manifest["runtimes"]["surrealdb"]["binarySha256"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(bridge_closed)?;
    Ok(digest.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexLoginInput {
    alias: String,
    new_account: bool,
}

struct ValidatedCodexLogin {
    alias: String,
    new_account: bool,
}

fn validate_codex_login_input(input: CodexLoginInput) -> Result<ValidatedCodexLogin, PublicError> {
    let alias = input.alias.trim().to_owned();
    if alias.is_empty() || alias.chars().count() > 128 || alias.contains(['\0', '\r', '\n']) {
        return Err(PublicError::new(
            "invalid_input",
            "Codex 계정 이름이 유효하지 않습니다",
        ));
    }
    Ok(ValidatedCodexLogin {
        alias,
        new_account: input.new_account,
    })
}

fn codex_login_arguments(entry: &Path, input: &ValidatedCodexLogin) -> Vec<OsString> {
    vec![
        entry.as_os_str().to_owned(),
        OsString::from(&input.alias),
        OsString::from(if input.new_account { "new" } else { "reuse" }),
    ]
}

struct ActiveCodexLogin {
    id: u64,
    child: Child,
}

#[derive(Default)]
struct CodexLoginProcess {
    active: Mutex<Option<ActiveCodexLogin>>,
    next_id: AtomicU64,
}

impl CodexLoginProcess {
    fn run(&self, paths: &RuntimePaths, input: CodexLoginInput) -> Result<Value, PublicError> {
        let input = validate_codex_login_input(input)?;
        let mut active = self.active.lock().map_err(|_| {
            PublicError::new(
                "codex_login_unavailable",
                "Codex 로그인을 시작하지 못했습니다",
            )
        })?;
        if active.is_some() {
            return Err(PublicError::new(
                "codex_login_busy",
                "Codex 로그인이 이미 진행 중입니다",
            ));
        }
        let mut command = Command::new(&paths.node);
        command
            .args(codex_login_arguments(&paths.desktop_login_entry, &input))
            .env_remove("MASSION_SURREALDB_BINARY")
            .envs(paths.child_environment())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn().map_err(|_| {
            PublicError::new(
                "codex_login_unavailable",
                "Codex 로그인을 시작하지 못했습니다",
            )
        })?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        *active = Some(ActiveCodexLogin { id, child });
        drop(active);

        let deadline = Instant::now() + CODEX_LOGIN_TIMEOUT;
        loop {
            let status = {
                let mut active = self.active.lock().map_err(|_| {
                    PublicError::new(
                        "codex_login_unavailable",
                        "Codex 로그인 상태를 확인하지 못했습니다",
                    )
                })?;
                let Some(login) = active.as_mut() else {
                    return Err(PublicError::new(
                        "codex_login_cancelled",
                        "Codex 로그인이 중단되었습니다",
                    ));
                };
                if login.id != id {
                    return Err(PublicError::new(
                        "codex_login_cancelled",
                        "Codex 로그인이 중단되었습니다",
                    ));
                }
                match login.child.try_wait() {
                    Ok(Some(status)) => {
                        *active = None;
                        Some(status)
                    }
                    Ok(None) => None,
                    Err(_) => {
                        Self::stop_locked(&mut active, id);
                        return Err(PublicError::new(
                            "codex_login_unavailable",
                            "Codex 로그인 상태를 확인하지 못했습니다",
                        ));
                    }
                }
            };
            if let Some(status) = status {
                return status
                    .success()
                    .then(|| json!({ "status": "ready" }))
                    .ok_or_else(|| {
                        PublicError::new(
                            "codex_login_failed",
                            "Codex 계정 연결을 완료하지 못했습니다",
                        )
                    });
            }
            if Instant::now() >= deadline {
                if let Ok(mut active) = self.active.lock() {
                    Self::stop_locked(&mut active, id);
                }
                return Err(PublicError::new(
                    "codex_login_timeout",
                    "Codex 로그인이 시간 안에 완료되지 않았습니다",
                ));
            }
            std::thread::sleep(CODEX_LOGIN_POLL);
        }
    }

    fn stop_locked(active: &mut Option<ActiveCodexLogin>, id: u64) {
        if active.as_ref().is_none_or(|login| login.id != id) {
            return;
        }
        if let Some(mut login) = active.take() {
            Self::terminate(&mut login.child);
        }
    }

    #[cfg(unix)]
    fn terminate(child: &mut Child) {
        let group = format!("-{}", child.id());
        let signal_group = |signal: &str| {
            Command::new("/bin/kill")
                .args([signal, &group])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        };
        let _ = signal_group("-TERM");
        std::thread::sleep(Duration::from_millis(250));
        if !signal_group("-KILL") {
            let _ = child.kill();
        }
        let _ = child.wait();
    }

    #[cfg(not(unix))]
    fn terminate(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    fn shutdown(&self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(login) = active.as_ref() {
                let id = login.id;
                Self::stop_locked(&mut active, id);
            }
        }
    }
}

struct Bridge {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    router: Arc<ResponseRouter>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    shutting_down: AtomicBool,
}

impl Bridge {
    fn spawn(paths: RuntimePaths, app: tauri::AppHandle) -> Result<Self, PublicError> {
        let environment = paths.child_environment();
        let mut child = Command::new(&paths.node)
            .arg(&paths.bridge_entry)
            .env_remove("MASSION_SURREALDB_BINARY")
            .envs(environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| bridge_closed())?;
        let writer = child.stdin.take().ok_or_else(bridge_closed)?;
        let stdout = child.stdout.take().ok_or_else(bridge_closed)?;
        let router = Arc::new(ResponseRouter::default());
        let reader_router = Arc::clone(&router);
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = Arc::clone(&closed);

        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let read = reader
                    .by_ref()
                    .take((MAX_INCOMING_BYTES + 1) as u64)
                    .read_until(b'\n', &mut line);
                match read {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_INCOMING_BYTES => break,
                    Ok(_) => {
                        if line.last() == Some(&b'\n') {
                            line.pop();
                        }
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        match parse_incoming(&line)
                            .and_then(|message| reader_router.dispatch(message))
                        {
                            Ok(Some(event)) => {
                                let _ = app.emit(BRIDGE_EVENT, event);
                            }
                            Ok(None) => {}
                            Err(_) => break,
                        }
                    }
                    Err(_) => break,
                }
            }
            reader_closed.store(true, Ordering::Release);
            reader_router.fail_all();
        });

        Ok(Self {
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            router,
            next_id: AtomicU64::new(1),
            closed,
            shutting_down: AtomicBool::new(false),
        })
    }

    fn request(&self, method: BridgeMethod, params: Value) -> Result<Value, PublicError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(bridge_closed());
        }
        let id = format!("native-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let receiver = self.router.register(&id)?;
        let frame = match encode_request(&id, method, params) {
            Ok(frame) => frame,
            Err(error) => {
                self.router.cancel(&id);
                return Err(error);
            }
        };
        let written = self
            .writer
            .lock()
            .map_err(|_| bridge_closed())
            .and_then(|mut writer| {
                writer
                    .write_all(&frame)
                    .and_then(|_| writer.flush())
                    .map_err(|_| bridge_closed())
            });
        if let Err(error) = written {
            self.router.cancel(&id);
            return Err(error);
        }
        let response = receiver
            .recv_timeout(response_timeout(method))
            .map_err(|_| {
                self.router.cancel(&id);
                bridge_closed()
            })?;
        if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response.error.unwrap_or_else(bridge_closed))
        }
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.request(BridgeMethod::Shutdown, json!({}));
        if let Ok(mut child) = self.child.lock() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

async fn call_bridge(
    bridge: Arc<Bridge>,
    method: BridgeMethod,
    params: Value,
) -> Result<Value, PublicError> {
    tauri::async_runtime::spawn_blocking(move || bridge.request(method, params))
        .await
        .map_err(|_| bridge_closed())?
}

fn object_params(value: Value) -> Result<Value, PublicError> {
    value
        .is_object()
        .then_some(value)
        .ok_or_else(|| PublicError::new("invalid_input", "요청 입력은 JSON 객체여야 합니다"))
}

#[derive(Deserialize)]
struct StreamInput {
    stream: StreamName,
    #[serde(default = "empty_object")]
    params: Value,
}

fn empty_object() -> Value {
    json!({})
}

#[tauri::command]
async fn bootstrap(
    state: tauri::State<'_, Arc<Bridge>>,
    input: Option<Value>,
) -> Result<Value, PublicError> {
    let bridge = Arc::clone(state.inner());
    let protocol = call_bridge(Arc::clone(&bridge), BridgeMethod::Hello, json!({})).await?;
    let connection = call_bridge(
        bridge,
        BridgeMethod::Connect,
        object_params(input.unwrap_or_else(empty_object))?,
    )
    .await?;
    Ok(json!({ "protocol": protocol, "connection": connection }))
}

macro_rules! bridge_command {
    ($name:ident, $method:expr) => {
        #[tauri::command]
        async fn $name(
            state: tauri::State<'_, Arc<Bridge>>,
            input: Value,
        ) -> Result<Value, PublicError> {
            call_bridge(Arc::clone(state.inner()), $method, object_params(input)?).await
        }
    };
}

bridge_command!(query, BridgeMethod::Query);
bridge_command!(command, BridgeMethod::Command);

#[tauri::command]
async fn codex_login(
    login: tauri::State<'_, Arc<CodexLoginProcess>>,
    paths: tauri::State<'_, Arc<RuntimePaths>>,
    input: CodexLoginInput,
) -> Result<Value, PublicError> {
    let login = Arc::clone(login.inner());
    let paths = Arc::clone(paths.inner());
    tauri::async_runtime::spawn_blocking(move || login.run(&paths, input))
        .await
        .map_err(|_| {
            PublicError::new(
                "codex_login_unavailable",
                "Codex 로그인을 완료하지 못했습니다",
            )
        })?
}

#[tauri::command]
async fn stream_start(
    state: tauri::State<'_, Arc<Bridge>>,
    input: StreamInput,
) -> Result<Value, PublicError> {
    let method = match input.stream {
        StreamName::Events => BridgeMethod::EventsStart,
        StreamName::Executions => BridgeMethod::ExecutionsStart,
    };
    call_bridge(
        Arc::clone(state.inner()),
        method,
        object_params(input.params)?,
    )
    .await
}

#[tauri::command]
async fn stream_stop(
    state: tauri::State<'_, Arc<Bridge>>,
    input: StreamInput,
) -> Result<Value, PublicError> {
    let method = match input.stream {
        StreamName::Events => BridgeMethod::EventsStop,
        StreamName::Executions => BridgeMethod::ExecutionsStop,
    };
    call_bridge(
        Arc::clone(state.inner()),
        method,
        object_params(input.params)?,
    )
    .await
}

#[derive(Clone, Copy)]
enum BridgeShutdownEvent {
    ExitRequested,
    WindowCloseRequested,
    Exit,
    Other,
}

fn should_shutdown_bridge(event: BridgeShutdownEvent) -> bool {
    matches!(
        event,
        BridgeShutdownEvent::ExitRequested
            | BridgeShutdownEvent::WindowCloseRequested
            | BridgeShutdownEvent::Exit
    )
}

fn webview_created_navigation_target(
    label: &str,
    release_build: bool,
    already_navigated: bool,
) -> Option<&'static str> {
    (release_build && !already_navigated && label == MAIN_WEBVIEW_LABEL)
        .then_some(BUNDLED_FRONTEND_URL)
}

fn navigate_main_webview_when_created(webview: tauri::Webview, navigated: &AtomicBool) {
    let Some(url) = webview_created_navigation_target(
        webview.label(),
        !cfg!(debug_assertions),
        navigated.load(Ordering::Acquire),
    ) else {
        return;
    };
    if navigated
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let url = tauri::Url::parse(url).expect("고정된 번들 프런트엔드 URL");
    if let Err(error) = webview.navigate(url) {
        navigated.store(false, Ordering::Release);
        eprintln!("초기 WebView 탐색 실패: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_navigation_done = Arc::new(AtomicBool::new(false));
    let startup_navigation_done_ = Arc::clone(&startup_navigation_done);
    let app = tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("startup-navigation")
                .on_webview_ready(move |webview| {
                    navigate_main_webview_when_created(webview, &startup_navigation_done_);
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = RuntimePaths::discover(app.handle())?;
            let bridge = Bridge::spawn(paths.clone(), app.handle().clone())?;
            app.manage(Arc::new(paths));
            app.manage(Arc::new(bridge));
            app.manage(Arc::new(CodexLoginProcess::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            query,
            command,
            codex_login,
            stream_start,
            stream_stop
        ])
        .build(tauri::generate_context!())
        .expect("Massion desktop 실행 준비 실패");

    app.run(|app_handle, event| {
        let shutdown_event = match event {
            tauri::RunEvent::ExitRequested { .. } => BridgeShutdownEvent::ExitRequested,
            tauri::RunEvent::Exit => BridgeShutdownEvent::Exit,
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => BridgeShutdownEvent::WindowCloseRequested,
            _ => BridgeShutdownEvent::Other,
        };
        if should_shutdown_bridge(shutdown_event) {
            if let Some(login) = app_handle.try_state::<Arc<CodexLoginProcess>>() {
                login.shutdown();
            }
            if let Some(bridge) = app_handle.try_state::<Arc<Bridge>>() {
                bridge.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn request_is_one_jsonl_frame_and_rejects_more_than_one_megabyte() {
        let encoded = encode_request(
            "native-1",
            BridgeMethod::Query,
            json!({ "operation": "work.index" }),
        )
        .expect("요청 프레임");

        assert_eq!(encoded.last(), Some(&b'\n'));
        assert_eq!(
            encoded[..encoded.len() - 1]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count(),
            0
        );

        let error = encode_request(
            "native-2",
            BridgeMethod::Command,
            json!({ "content": "x".repeat(MAX_REQUEST_BYTES) }),
        )
        .expect_err("1MiB를 넘는 요청은 거부해야 함");
        assert_eq!(error.code, "bridge_request_too_large");
    }

    #[test]
    fn tauri_bootstrap_does_not_transport_the_http_owner_capability() {
        let encoded = encode_request("native-bootstrap", BridgeMethod::Connect, json!({}))
            .expect("bootstrap 연결 요청");
        let text = String::from_utf8(encoded).expect("UTF-8 bootstrap 요청");

        assert!(text.contains(r#""method":"connect""#));
        assert!(!text.to_ascii_lowercase().contains("capability"));
        assert!(!text.to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn response_and_event_are_parsed_without_exposing_private_error_fields() {
        let response = parse_incoming(
            r#"{"id":"native-1","ok":false,"error":{"code":"denied","message":"승인이 필요합니다","stack":"secret stack","headers":{"authorization":"secret"}}}"#.as_bytes(),
        )
        .expect("응답 파싱");
        let Incoming::Response(response) = response else {
            panic!("응답으로 분류해야 함");
        };
        assert_eq!(response.id, "native-1");
        let exposed = serde_json::to_value(response.error.expect("공개 오류")).expect("JSON 변환");
        assert_eq!(
            exposed,
            json!({ "code": "denied", "message": "승인이 필요합니다" })
        );

        let event = parse_incoming(
            br#"{"type":"event","stream":"executions","payload":{"executionId":"execution-1"}}"#,
        )
        .expect("이벤트 파싱");
        assert!(matches!(event, Incoming::Event(_)));
    }

    #[test]
    fn id_router_keeps_interleaved_events_out_of_pending_responses() {
        let router = ResponseRouter::default();
        let first = router.register("native-1").expect("첫 번째 요청 등록");
        let second = router.register("native-2").expect("두 번째 요청 등록");

        let event = router
            .dispatch(
                parse_incoming(
                    br#"{"type":"event","stream":"events","payload":{"kind":"work.created"}}"#,
                )
                .unwrap(),
            )
            .expect("이벤트 라우팅");
        assert!(event.is_some());

        router
            .dispatch(
                parse_incoming(br#"{"id":"native-2","ok":true,"result":{"value":2}}"#).unwrap(),
            )
            .expect("두 번째 응답 라우팅");
        router
            .dispatch(
                parse_incoming(br#"{"id":"native-1","ok":true,"result":{"value":1}}"#).unwrap(),
            )
            .expect("첫 번째 응답 라우팅");

        assert_eq!(
            first.recv_timeout(Duration::from_millis(20)).unwrap().id,
            "native-1"
        );
        assert_eq!(
            second.recv_timeout(Duration::from_millis(20)).unwrap().id,
            "native-2"
        );
    }

    #[test]
    fn bridge_shutdowns_when_the_last_window_closes_or_the_app_exits() {
        assert!(should_shutdown_bridge(
            BridgeShutdownEvent::WindowCloseRequested
        ));
        assert!(should_shutdown_bridge(BridgeShutdownEvent::ExitRequested));
        assert!(should_shutdown_bridge(BridgeShutdownEvent::Exit));
        assert!(!should_shutdown_bridge(BridgeShutdownEvent::Other));
    }

    #[test]
    fn only_the_first_created_main_webview_in_release_gets_the_bundled_url() {
        assert_eq!(
            webview_created_navigation_target("main", true, false),
            Some("tauri://localhost")
        );
        assert_eq!(webview_created_navigation_target("main", true, true), None);
        assert_eq!(
            webview_created_navigation_target("settings", true, false),
            None
        );
        assert_eq!(
            webview_created_navigation_target("main", false, false),
            None
        );
    }

    #[test]
    fn command_response_timeout_is_five_minutes() {
        assert_eq!(
            response_timeout(BridgeMethod::Command),
            Duration::from_secs(300)
        );
    }

    #[test]
    fn non_command_response_timeouts_remain_thirty_seconds() {
        for method in [
            BridgeMethod::Hello,
            BridgeMethod::Query,
            BridgeMethod::EventsStart,
            BridgeMethod::EventsStop,
            BridgeMethod::ExecutionsStart,
            BridgeMethod::ExecutionsStop,
            BridgeMethod::Shutdown,
        ] {
            assert_eq!(response_timeout(method), Duration::from_secs(30));
        }
    }

    #[test]
    fn connect_response_timeout_outlives_local_daemon_startup_budget() {
        assert_eq!(
            response_timeout(BridgeMethod::Connect),
            Duration::from_secs(600)
        );
    }

    #[test]
    fn tauri_configuration_is_local_only_and_has_a_restricted_capability() {
        let config: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("Tauri 설정 JSON");
        assert_eq!(config["build"]["frontendDist"], "../dist");
        assert_eq!(config["app"]["withGlobalTauri"], false);
        assert!(config["app"]["security"]["csp"]
            .as_str()
            .is_some_and(
                |csp| csp.contains("default-src 'self'") && csp.contains("object-src 'none'")
            ));
        assert_eq!(
            config["app"]["security"]["capabilities"],
            json!(["default"])
        );
        assert_eq!(config["app"]["windows"][0]["minWidth"], 1180);
        assert_eq!(config["app"]["windows"][0]["minHeight"], 720);

        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("capability JSON");
        assert!(capability.get("remote").is_none());
        assert_eq!(
            capability["permissions"],
            json!([
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "dialog:allow-open",
                "allow-bootstrap",
                "allow-query",
                "allow-command",
                "allow-codex-login",
                "allow-stream-start",
                "allow-stream-stop"
            ])
        );
    }

    #[test]
    fn release_inputs_are_pinned_for_apple_silicon() {
        let manifest: Value = serde_json::from_str(include_str!("../runtime-manifest.json"))
            .expect("runtime manifest JSON");
        assert_eq!(manifest["target"], "aarch64-apple-darwin");
        assert_eq!(manifest["runtimes"]["node"]["version"], "24.18.0");
        assert_eq!(manifest["runtimes"]["surrealdb"]["version"], "3.2.1");
        let node = &manifest["runtimes"]["node"];
        assert!(node["archiveUrl"]
            .as_str()
            .is_some_and(|url| url.ends_with("node-v24.18.0-darwin-arm64.tar.xz")));
        assert_eq!(
            node["archiveSha256"],
            "4477b9f78efb77744cf5eb57a0e9594dba66466b38b4e93fa9f35cb907a095a6"
        );
        assert_eq!(
            node["binarySha256"],
            "ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a"
        );
        for runtime in ["node", "surrealdb"] {
            assert!(manifest["runtimes"][runtime]["input"]
                .as_str()
                .is_some_and(|path| path.ends_with("-aarch64-apple-darwin")));
            assert_eq!(
                manifest["runtimes"][runtime]["archiveSha256"]
                    .as_str()
                    .map(str::len),
                Some(64)
            );
        }
        let node_input = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(node["input"].as_str().expect("Node externalBin input 경로"));
        if node_input.exists() {
            let metadata = fs::metadata(node_input).expect("Node externalBin metadata");
            assert!(metadata.is_file());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_ne!(metadata.permissions().mode() & 0o111, 0);
            }
        }

        let release: Value = serde_json::from_str(include_str!("../tauri.release.conf.json"))
            .expect("release config JSON");
        assert_eq!(
            release["bundle"]["externalBin"],
            json!(["binaries/node", "binaries/surrealdb"])
        );
    }

    fn write_file(path: &Path) {
        fs::create_dir_all(path.parent().expect("부모 경로")).unwrap();
        fs::write(path, "fixture").unwrap();
    }

    #[test]
    fn runtime_paths_are_absolute_and_supply_the_bridge_environment() {
        let root = std::env::temp_dir().join(format!(
            "massion-runtime-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manifest_dir = root.join("apps/desktop/src-tauri");
        let node = root.join("bin/node");
        let surreal = root.join("bin/surreal");
        fs::create_dir_all(&manifest_dir).unwrap();
        write_file(&node);
        write_file(&surreal);
        write_file(&root.join("apps/desktop-bridge/dist/entry.js"));
        write_file(&root.join("apps/cli/dist/desktop-login.js"));
        write_file(&root.join("apps/server/dist/main.js"));

        let paths = RuntimePaths::development(&manifest_dir, &node, &surreal).unwrap();
        assert!(paths.bridge_entry.is_absolute());
        assert_eq!(
            paths.desktop_login_entry,
            root.join("apps/cli/dist/desktop-login.js")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            paths.bridge_entry,
            root.join("apps/desktop-bridge/dist/entry.js")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            paths.server_entry,
            root.join("apps/server/dist/main.js")
                .canonicalize()
                .unwrap()
        );
        let environment = paths.child_environment();
        assert_eq!(
            environment.get("MASSION_SERVER_BIN").unwrap(),
            paths.server_entry.as_os_str()
        );
        assert_eq!(
            environment.get("MASSION_SURREAL_BINARY").unwrap(),
            paths.surrealdb.as_os_str()
        );
        assert_eq!(
            environment.get("MASSION_SURREAL_SHA256").unwrap(),
            std::ffi::OsStr::new(
                "78d1a4593759bce976836f8691457ce20fe8a28ec266fb275d780a4708db1899"
            )
        );
        assert!(!environment.contains_key("MASSION_SURREALDB_BINARY"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn development_runtime_uses_the_staged_surrealdb_sidecar() {
        let root = std::env::temp_dir().join(format!(
            "massion-development-surreal-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manifest_dir = root.join("apps/desktop/src-tauri");
        let source = manifest_dir.join("binaries/surrealdb-aarch64-apple-darwin");
        write_file(&source);

        assert_eq!(
            development_surrealdb_sidecar(&manifest_dir).unwrap(),
            source.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundled_paths_use_the_staged_runtime_and_adjacent_sidecars() {
        let root = std::env::temp_dir().join(format!(
            "massion-bundled-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let executable_dir = root.join("Massion.app/Contents/MacOS");
        let resources = root.join("Massion.app/Contents/Resources");
        write_file(&executable_dir.join("node"));
        write_file(&executable_dir.join("surrealdb"));
        write_file(&resources.join("desktop-bridge/dist/entry.js"));
        write_file(&resources.join("cli/dist/desktop-login.js"));
        write_file(&resources.join("server/dist/main.js"));

        let paths = RuntimePaths::bundled(&executable_dir, &resources).unwrap();
        assert_eq!(
            paths.node,
            executable_dir.join("node").canonicalize().unwrap()
        );
        assert_eq!(
            paths.bridge_entry,
            resources
                .join("desktop-bridge/dist/entry.js")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            paths.desktop_login_entry,
            resources
                .join("cli/dist/desktop-login.js")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            paths.server_entry,
            resources
                .join("server/dist/main.js")
                .canonicalize()
                .unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn release_resources_only_copy_a_self_contained_staging_directory() {
        let release: Value = serde_json::from_str(include_str!("../tauri.release.conf.json"))
            .expect("release config JSON");
        assert_eq!(
            release["bundle"]["resources"],
            json!({ ".runtime-stage/": "" })
        );

        let staging: Value = serde_json::from_str(include_str!("../runtime-stage.manifest.json"))
            .expect("runtime stage manifest JSON");
        assert_eq!(
            staging["build"],
            json!(["@massion/server", "@massion/desktop-bridge", "@massion/cli"])
        );
        assert_eq!(staging["bridge"]["package"], "@massion/desktop-bridge");
        assert_eq!(staging["bridge"]["entry"], "dist/entry.js");
        assert_eq!(staging["server"]["package"], "@massion/server");
        assert_eq!(staging["server"]["entry"], "dist/main.js");
        assert_eq!(staging["cli"]["package"], "@massion/cli");
        assert_eq!(staging["cli"]["entry"], "dist/desktop-login.js");
        assert_eq!(staging["deployment"], "pnpm-deploy-prod-isolated");
    }

    #[test]
    fn codex_login_accepts_only_a_bounded_single_line_alias_and_fixed_intent() {
        let input = validate_codex_login_input(CodexLoginInput {
            alias: "  OpenAI Codex  ".to_owned(),
            new_account: true,
        })
        .expect("유효한 Codex login 입력");
        assert_eq!(input.alias, "OpenAI Codex");
        assert_eq!(
            codex_login_arguments(Path::new("/runtime/desktop-login.js"), &input),
            vec![
                OsString::from("/runtime/desktop-login.js"),
                OsString::from("OpenAI Codex"),
                OsString::from("new")
            ]
        );

        for alias in ["", "bad\nalias", "bad\ralias", &"x".repeat(129)] {
            assert!(validate_codex_login_input(CodexLoginInput {
                alias: alias.to_owned(),
                new_account: false,
            })
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_login_shutdown_terminates_the_wrapper_and_its_descendants() {
        let root = std::env::temp_dir().join(format!(
            "massion-codex-login-tree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let script = root.join("login.sh");
        let descendant_pid = root.join("descendant.pid");
        fs::write(
            &script,
            "#!/bin/sh\nsleep 30 &\nprintf '%s' \"$!\" > \"$1\"\nwait\n",
        )
        .unwrap();
        let paths = RuntimePaths {
            node: PathBuf::from("/bin/sh"),
            bridge_entry: PathBuf::from("/unused/bridge.js"),
            desktop_login_entry: script,
            server_entry: PathBuf::from("/unused/server.js"),
            surrealdb: PathBuf::from("/unused/surrealdb"),
            surreal_sha256: "0".repeat(64),
            bundled_extensions: None,
        };
        let login = Arc::new(CodexLoginProcess::default());
        let running = Arc::clone(&login);
        let alias = descendant_pid.to_string_lossy().into_owned();
        assert!(alias.chars().count() <= 128);
        let runner = std::thread::spawn(move || {
            running.run(
                &paths,
                CodexLoginInput {
                    alias,
                    new_account: false,
                },
            )
        });

        for _ in 0..100 {
            if descendant_pid.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = fs::read_to_string(&descendant_pid).expect("손자 process pid");
        login.shutdown();
        assert_eq!(
            runner.join().unwrap().unwrap_err().code,
            "codex_login_cancelled"
        );
        for _ in 0..100 {
            if !Command::new("/bin/kill")
                .args(["-0", pid.trim()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
            {
                fs::remove_dir_all(root).unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("Codex login 손자 process가 종료되지 않았습니다");
    }
}
