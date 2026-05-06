use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{fs, panic};

use anyhow::{Context, Result, anyhow};
use crossbeam_channel::{Receiver, Sender, unbounded};
use eframe::egui;
use egui::{
    Align2, Color32, CornerRadius, FontId, Frame, Margin, Pos2, Rect, RichText, Sense, Stroke,
    StrokeKind, Vec2,
};
use serde::Deserialize;
use serde_json::Value;

const MAX_LOG_ENTRIES: usize = 800;
const MAX_VISIBLE_LOG_ENTRIES: usize = 40;
const MAX_VISIBLE_FAMILY_ROWS: usize = 18;
const BG: Color32 = Color32::from_rgb(246, 248, 252);
const PANEL: Color32 = Color32::from_rgb(255, 255, 255);
const PANEL_SOFT: Color32 = Color32::from_rgb(248, 250, 253);
const LINE: Color32 = Color32::from_rgb(220, 226, 235);
const TEXT: Color32 = Color32::from_rgb(24, 29, 38);
const MUTED: Color32 = Color32::from_rgb(104, 115, 132);
const CYAN: Color32 = Color32::from_rgb(0, 122, 255);
const GREEN: Color32 = Color32::from_rgb(44, 180, 112);
const AMBER: Color32 = Color32::from_rgb(238, 143, 35);
const PINK: Color32 = Color32::from_rgb(175, 82, 222);
const BLUE: Color32 = Color32::from_rgb(64, 116, 255);
const SPLASH_TOTAL_SECONDS: f32 = 4.15;
const EMBEDDED_SEED_SCRIPT: &str = include_str!("../seed_universe_sites.js");
const EMBEDDED_SPAWN_PROFILES: &[u8] = include_bytes!("../data/spec/dungeonSpawnProfiles.json");

fn main() -> Result<()> {
    install_panic_hook();

    if std::env::args().any(|argument| argument == "--health-check") {
        return run_cli_health_check();
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Elysian Universe Site Seeder")
            .with_inner_size([1260.0, 900.0])
            .with_min_inner_size([1040.0, 760.0]),
        renderer: eframe::Renderer::Wgpu,
        run_and_return: false,
        ..Default::default()
    };

    eframe::run_native(
        "Elysian Universe Site Seeder",
        options,
        Box::new(|cc| {
            apply_visuals(&cc.egui_ctx);
            Ok(Box::new(UniverseSeederApp::new()))
        }),
    )
    .map_err(|error| anyhow!(error.to_string()))
}

fn install_panic_hook() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let mut lines = vec![
            "Elysian Universe Site Seeder crash".to_string(),
            format!("panic: {}", panic_info),
        ];

        if let Some(location) = panic_info.location() {
            lines.push(format!(
                "location: {}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            ));
        }

        if let Ok(current_dir) = std::env::current_dir() {
            lines.push(format!("current_dir: {}", current_dir.display()));
        }
        if let Ok(current_exe) = std::env::current_exe() {
            lines.push(format!("current_exe: {}", current_exe.display()));
        }
        if let Ok(backtrace) = std::env::var("RUST_BACKTRACE") {
            lines.push(format!("RUST_BACKTRACE={}", backtrace));
        }

        if let Some(log_path) = resolve_tool_root().map(|root| root.join("last-crash.log")) {
            let payload = lines.join("\n");
            let _ = fs::write(&log_path, payload);
            eprintln!(
                "Universe Site Seeder panic log written to {}",
                log_path.display()
            );
        }

        default_hook(panic_info);
    }));
}

fn resolve_tool_root() -> Option<PathBuf> {
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf)),
        std::env::current_dir().ok(),
    ];

    for candidate in candidates.into_iter().flatten() {
        let mut current = candidate.as_path();
        loop {
            if current.join("bin").join("UniverseSiteSeeder.exe").exists()
                || current.join("bin").join("UniverseSiteSeeder").exists()
                || current.join("bin").join("universe-site-seed").exists()
                || current.join("Install.bat").exists()
                || current.join("Install.sh").exists()
                || (current.join("Cargo.toml").exists()
                    && current.join("seed_universe_sites.js").exists())
            {
                return Some(current.to_path_buf());
            }
            match current.parent() {
                Some(parent) => current = parent,
                None => break,
            }
        }
    }
    None
}

fn looks_like_evejs_root(path: &Path) -> bool {
    let data = path
        .join("server")
        .join("src")
        .join("newDatabase")
        .join("data");
    [
        data.join("dungeonAuthority").join("data.json"),
        data.join("dungeonRuntimeState").join("data.json"),
        data.join("miningRuntimeState").join("data.json"),
    ]
    .iter()
    .all(|entry| entry.exists())
}

fn read_saved_evejs_root() -> Option<PathBuf> {
    let tool_root = resolve_tool_root()?;
    let saved_path = tool_root.join("config").join("evejs.path");
    let value = fs::read_to_string(saved_path).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

struct EmbeddedRuntime {
    root: PathBuf,
    script_path: PathBuf,
}

impl Drop for EmbeddedRuntime {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn materialize_embedded_runtime() -> Result<EmbeddedRuntime> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let root = std::env::temp_dir().join(format!(
        "evejs-universe-seeder-{}-{}",
        std::process::id(),
        stamp
    ));
    let spec_dir = root.join("data").join("spec");
    fs::create_dir_all(&spec_dir)
        .with_context(|| format!("Failed to prepare runtime folder {}", root.display()))?;

    let script_path = root.join("seed_universe_sites.js");
    fs::write(&script_path, EMBEDDED_SEED_SCRIPT)
        .with_context(|| format!("Failed to prepare seeder engine {}", script_path.display()))?;
    fs::write(
        spec_dir.join("dungeonSpawnProfiles.json"),
        EMBEDDED_SPAWN_PROFILES,
    )
    .with_context(|| "Failed to prepare embedded seeder data")?;

    Ok(EmbeddedRuntime { root, script_path })
}

fn apply_visuals(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::light();
    visuals.override_text_color = Some(TEXT);
    visuals.widgets.noninteractive.bg_fill = PANEL;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.inactive.bg_fill = PANEL_SOFT;
    visuals.widgets.inactive.weak_bg_fill = PANEL_SOFT;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, LINE);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(239, 245, 255);
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(239, 245, 255);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, CYAN);
    visuals.widgets.active.bg_fill = Color32::from_rgb(225, 237, 255);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(225, 237, 255);
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, CYAN);
    visuals.selection.bg_fill = Color32::from_rgb(211, 230, 255);
    visuals.selection.stroke = Stroke::new(1.0, CYAN);
    visuals.window_fill = BG;
    visuals.panel_fill = BG;
    visuals.window_stroke = Stroke::new(1.0, LINE);
    visuals.window_corner_radius = CornerRadius::same(8);
    visuals.menu_corner_radius = CornerRadius::same(8);
    visuals.extreme_bg_color = Color32::from_rgb(235, 239, 246);
    visuals.faint_bg_color = Color32::from_rgb(235, 239, 246);
    visuals.hyperlink_color = CYAN;
    ctx.set_visuals(visuals);
    ctx.set_pixels_per_point(1.0);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskKind {
    Inspect,
    Seed,
    ForceReseed,
}

impl TaskKind {
    fn label(self) -> &'static str {
        match self {
            TaskKind::Inspect => "Inspect",
            TaskKind::Seed => "Seed Universe",
            TaskKind::ForceReseed => "Force Reseed Universe",
        }
    }
}

#[derive(Clone)]
struct LogEntry {
    level: String,
    message: String,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoEvent {
    repo_root: String,
    data_root: String,
    tool_root: String,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCounts {
    broad_count: u64,
    generated_mining_count: u64,
    by_family: std::collections::BTreeMap<String, u64>,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    full_up_to_date: bool,
    broad_up_to_date: bool,
    mining_up_to_date: bool,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectEvent {
    repo_root: String,
    cpu_cores: u64,
    batch_size: u64,
    server_port: u64,
    system_count: u64,
    universe_families: Vec<String>,
    runtime_counts: RuntimeCounts,
    status: StatusEvent,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhaseEvent {
    phase: String,
    current: u64,
    total: u64,
    ratio: f32,
    label: Option<String>,
    family: Option<String>,
    sites_built: Option<u64>,
    family_site_count: Option<u64>,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryFamily {
    desired_site_count: u64,
    systems_touched: u64,
    template_count: u64,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryMining {
    desired_site_count: u64,
}

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryEvent {
    skipped: Option<bool>,
    reason: Option<String>,
    system_count: Option<u64>,
    desired_site_count: Option<u64>,
    created_instances: Option<u64>,
    retained_instances: Option<u64>,
    replaced_instances: Option<u64>,
    removed_instances: Option<u64>,
    mining_state_rows_created: Option<u64>,
    mining_state_rows_removed: Option<u64>,
    elapsed_ms: Option<u64>,
    mining: Option<SummaryMining>,
    families: Option<std::collections::BTreeMap<String, SummaryFamily>>,
    runtime_counts: Option<RuntimeCounts>,
}

enum ToolMessage {
    Repo(RepoEvent),
    Inspect(InspectEvent),
    Phase(PhaseEvent),
    Summary(SummaryEvent),
    Log(LogEntry),
    Finished(Result<(), String>),
}

struct UniverseSeederApp {
    repo: Option<RepoEvent>,
    inspect: Option<InspectEvent>,
    phase: Option<PhaseEvent>,
    summary: Option<SummaryEvent>,
    logs: Vec<LogEntry>,
    run_log_path: Option<PathBuf>,
    last_error: Option<String>,
    running: bool,
    current_task: Option<TaskKind>,
    receiver: Option<Receiver<ToolMessage>>,
    started_at: Option<Instant>,
    splash_started_at: Instant,
}

impl UniverseSeederApp {
    fn new() -> Self {
        let mut app = Self {
            repo: None,
            inspect: None,
            phase: None,
            summary: None,
            logs: Vec::new(),
            run_log_path: None,
            last_error: None,
            running: false,
            current_task: None,
            receiver: None,
            started_at: None,
            splash_started_at: Instant::now(),
        };
        app.start_task(TaskKind::Inspect);
        app
    }

    fn resolve_repo_root() -> Option<PathBuf> {
        let candidates = [
            std::env::var_os("EVEJS_REPO_ROOT").map(PathBuf::from),
            read_saved_evejs_root(),
            resolve_tool_root(),
            std::env::current_dir().ok(),
        ];

        for candidate in candidates.into_iter().flatten() {
            let mut current = candidate.as_path();
            loop {
                if looks_like_evejs_root(current) {
                    return Some(current.to_path_buf());
                }
                match current.parent() {
                    Some(parent) => current = parent,
                    None => break,
                }
            }
        }
        None
    }

    fn tool_root() -> Option<PathBuf> {
        resolve_tool_root()
    }

    fn start_task(&mut self, task: TaskKind) {
        if self.running {
            return;
        }

        let Some(repo_root) = Self::resolve_repo_root() else {
            self.last_error = Some(
                "Could not find the EVE JS folder. Run Install.bat or Install.sh once, or launch from inside the EVE JS repo."
                    .to_string(),
            );
            self.push_log(LogEntry {
                level: "error".to_string(),
                message: "Could not find the EVE JS folder. Run Install.bat or Install.sh once, or launch from inside the EVE JS repo."
                    .to_string(),
            });
            return;
        };
        let Some(tool_root) = Self::tool_root() else {
            self.last_error = Some("Could not find the seeder app folder.".to_string());
            self.push_log(LogEntry {
                level: "error".to_string(),
                message: "Could not find the seeder app folder.".to_string(),
            });
            return;
        };

        let (sender, receiver) = unbounded();
        self.receiver = Some(receiver);
        self.running = true;
        self.current_task = Some(task);
        self.started_at = Some(Instant::now());
        self.phase = None;
        self.summary = None;
        self.last_error = None;
        self.logs.clear();
        self.run_log_path = Some(tool_root.join("last-run.log"));
        if let Some(path) = &self.run_log_path {
            let _ = fs::write(path, "");
        }
        self.push_log(LogEntry {
            level: "info".to_string(),
            message: format!("Starting {}...", task.label()),
        });

        thread::spawn(move || {
            let result = run_seed_process(&repo_root, &tool_root, task, sender.clone());
            let _ = sender.send(ToolMessage::Finished(
                result.map_err(|error| error.to_string()),
            ));
        });
    }

    fn poll_messages(&mut self) {
        let Some(receiver) = self.receiver.clone() else {
            return;
        };

        while let Ok(message) = receiver.try_recv() {
            match message {
                ToolMessage::Repo(repo) => self.repo = Some(repo),
                ToolMessage::Inspect(inspect) => self.inspect = Some(inspect),
                ToolMessage::Phase(phase) => self.phase = Some(phase),
                ToolMessage::Summary(summary) => self.summary = Some(summary),
                ToolMessage::Log(entry) => {
                    if entry.level == "error" {
                        self.last_error = Some(entry.message.clone());
                    }
                    self.push_log(entry);
                }
                ToolMessage::Finished(result) => {
                    self.running = false;
                    self.current_task = None;
                    if let Err(error) = result {
                        if self.last_error.is_none() {
                            self.last_error = Some(error.clone());
                        }
                        self.push_log(LogEntry {
                            level: "error".to_string(),
                            message: error,
                        });
                    } else {
                        self.last_error = None;
                        self.push_log(LogEntry {
                            level: "success".to_string(),
                            message: "Seeder task finished.".to_string(),
                        });
                    }
                }
            }
        }
    }

    fn push_log(&mut self, entry: LogEntry) {
        if let Some(path) = &self.run_log_path {
            let formatted = format!("[{}] {}\n", entry.level.to_uppercase(), entry.message);
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut file| std::io::Write::write_all(&mut file, formatted.as_bytes()));
        }
        self.logs.push(entry);
        let overflow = self.logs.len().saturating_sub(MAX_LOG_ENTRIES);
        if overflow > 0 {
            self.logs.drain(0..overflow);
        }
    }

    fn status_badge(&self) -> (&'static str, Color32, Color32) {
        if self.running {
            return ("Checking", Color32::from_rgb(229, 243, 255), CYAN);
        }
        if let Some(inspect) = &self.inspect {
            if inspect.status.full_up_to_date {
                return ("Current", Color32::from_rgb(230, 248, 239), GREEN);
            }
            return ("Update Ready", Color32::from_rgb(255, 244, 229), AMBER);
        }
        ("Preparing", Color32::from_rgb(237, 241, 247), MUTED)
    }

    fn open_path(path: &Path, select: bool) {
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("explorer.exe");
            if select {
                command.arg(format!("/select,{}", path.display()));
            } else {
                command.arg(path);
            }
            let _ = command.spawn();
        }

        #[cfg(target_os = "macos")]
        {
            let target = if select {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            let _ = Command::new("open").arg(target).spawn();
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let target = if select {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            let _ = Command::new("xdg-open").arg(target).spawn();
        }
    }

    fn draw_header(&self, ui: &mut egui::Ui) {
        let (badge_label, badge_fill, badge_text) = self.status_badge();
        let time = ui.input(|input| input.time);
        let available = ui.available_width();
        let hero_height = 224.0;
        let (rect, _) = ui.allocate_exact_size(Vec2::new(available, hero_height), Sense::hover());
        paint_clean_hero(ui, rect, time, self.running);
        let inner = rect.shrink2(Vec2::new(26.0, 24.0));
        let status_width = 286.0;
        let status_height = 134.0;
        let status_rect = Rect::from_min_size(
            Pos2::new(
                inner.right() - status_width,
                inner.center().y - status_height / 2.0,
            ),
            Vec2::new(status_width, status_height),
        );
        let left_rect = Rect::from_min_max(
            inner.left_top(),
            Pos2::new(status_rect.left() - 28.0, inner.bottom()),
        );

        ui.scope_builder(egui::UiBuilder::new().max_rect(left_rect), |ui| {
            ui.set_width(left_rect.width());
            ui.label(
                RichText::new("JOHN ELYSIAN PRESENTS")
                    .size(12.0)
                    .strong()
                    .color(CYAN),
            );
            ui.add_space(9.0);
            ui.add(
                egui::Label::new(
                    RichText::new("Elysian Universe Site Seeder")
                        .size(35.0)
                        .strong()
                        .color(TEXT),
                )
                .wrap(),
            )
            .on_hover_text("Designed by John Elysian.");
            ui.add_space(7.0);
            ui.add(
                egui::Label::new(
                    RichText::new(
                        "A guided setup assistant for EVE JS persistent universe site state.",
                    )
                    .size(16.0)
                    .color(MUTED),
                )
                .wrap(),
            );
            ui.add_space(14.0);
            ui.horizontal_wrapped(|ui| {
                small_pill(ui, "Designed by John Elysian", CYAN);
                small_pill(ui, "One clear next step", GREEN);
                small_pill(ui, "Local data", AMBER);
            });
            ui.add_space(12.0);
            ui.add(
                egui::Label::new(
                    RichText::new("Claims are easy. Shipping universes is harder.")
                        .size(13.0)
                        .italics()
                        .color(MUTED),
                )
                .wrap(),
            );
        });
        paint_status_card(ui, status_rect, time, badge_label, badge_fill, badge_text);
        ui.advance_cursor_after_rect(rect);
    }

    fn draw_guided_focus(&mut self, ui: &mut egui::Ui) {
        if let Some(error) = self.last_error.clone() {
            let (title, body, detail) = friendly_error(&error);
            if setup_focus(
                ui,
                IconKind::Bolt,
                title,
                &body,
                detail,
                Some(("Check Again", "Run the assessment")),
                AMBER,
            )
            .is_some_and(|response| response.clicked())
            {
                self.start_task(TaskKind::Inspect);
            }
            ui.add_space(18.0);
            ui.label(
                RichText::new("Secondary options")
                    .size(14.0)
                    .strong()
                    .color(MUTED),
            );
            ui.add_space(8.0);
            self.draw_option_row(ui);
            return;
        }

        let Some(repo) = &self.repo else {
            setup_focus(
                ui,
                IconKind::Scan,
                "Checking this universe",
                "Reading local EvEJS data and preparing the right next step.",
                "No files are changed during this first pass.",
                None,
                CYAN,
            );
            return;
        };

        let data_root = repo.data_root.clone();
        let tool_root = repo.tool_root.clone();
        let current = self
            .inspect
            .as_ref()
            .map(|inspect| inspect.status.full_up_to_date);

        let enabled = !self.running;
        match current {
            Some(true) => {
                if setup_focus(
                    ui,
                    IconKind::Check,
                    "You're up to date",
                    "The saved universe state already matches the current descriptor.",
                    "No write is needed. You can check again any time.",
                    Some(("Check Again", "Re-run the assessment")),
                    GREEN,
                )
                .is_some_and(|response| response.clicked() && enabled)
                {
                    self.start_task(TaskKind::Inspect);
                }
            }
            Some(false) => {
                if setup_focus(
                    ui,
                    IconKind::Rocket,
                    "Universe update is ready",
                    "The saved state is behind the current descriptor.",
                    "Seed Universe will bring runtime instances and metadata into sync.",
                    Some(("Seed Universe", "Start the guided update")),
                    CYAN,
                )
                .is_some_and(|response| response.clicked() && enabled)
                {
                    self.start_task(TaskKind::Seed);
                }
            }
            None => {
                if setup_focus(
                    ui,
                    IconKind::Scan,
                    "Check this universe",
                    "Start with a read-only pass so the app can choose the right next step.",
                    "Nothing is written during inspection.",
                    Some(("Assess", "Run the check")),
                    CYAN,
                )
                .is_some_and(|response| response.clicked() && enabled)
                {
                    self.start_task(TaskKind::Inspect);
                }
            }
        }

        ui.add_space(18.0);
        ui.label(
            RichText::new("Secondary options")
                .size(14.0)
                .strong()
                .color(MUTED),
        );
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            if icon_link(ui, IconKind::Scan, "Check Again", CYAN).clicked() && enabled {
                self.start_task(TaskKind::Inspect);
            }
            if icon_link(ui, IconKind::Bolt, "Force Rebuild", AMBER).clicked() && enabled {
                self.start_task(TaskKind::ForceReseed);
            }
            if icon_link(ui, IconKind::Database, "Data Folder", BLUE).clicked() {
                Self::open_path(Path::new(&data_root), false);
            }
            if icon_link(ui, IconKind::Folder, "Tool Folder", GREEN).clicked() {
                Self::open_path(Path::new(&tool_root), false);
            }
            let run_log_enabled = self.run_log_path.as_ref().is_some_and(|path| path.exists());
            let log_response = ui.add_enabled_ui(run_log_enabled, |ui| {
                icon_link(ui, IconKind::Log, "Last Log", PINK)
            });
            if log_response.inner.clicked() {
                if let Some(path) = &self.run_log_path {
                    Self::open_path(path, false);
                }
            }
        });
    }

    fn draw_metrics(&self, ui: &mut egui::Ui) {
        let repo_root = self
            .repo
            .as_ref()
            .map(|repo| repo.repo_root.clone())
            .or_else(|| {
                self.inspect
                    .as_ref()
                    .map(|inspect| inspect.repo_root.clone())
            })
            .unwrap_or_else(|| "Waiting for repo".to_string());
        let inspect = self.inspect.clone().unwrap_or_default();
        let runtime = inspect.runtime_counts.clone();
        let families = inspect.universe_families.len() as u64;

        ui.label(
            RichText::new("Universe Snapshot")
                .size(18.0)
                .strong()
                .color(TEXT),
        );
        ui.add_space(10.0);
        path_strip(ui, "Repository", &repo_root);
        ui.add_space(14.0);

        ui.columns(4, |columns| {
            metric_card(
                &mut columns[0],
                "Systems",
                &format!("{}", inspect.system_count),
                CYAN,
            );
            metric_card(&mut columns[1], "Families", &format!("{}", families), GREEN);
            metric_card(
                &mut columns[2],
                "Broad Sites",
                &format!("{}", runtime.broad_count),
                AMBER,
            );
            metric_card(
                &mut columns[3],
                "Mining Sites",
                &format!("{}", runtime.generated_mining_count),
                PINK,
            );
        });
        ui.add_space(14.0);
        ui.horizontal_wrapped(|ui| {
            info_chip(ui, format!("CPU cores {}", inspect.cpu_cores), CYAN);
            info_chip(ui, format!("Batch size {}", inspect.batch_size), GREEN);
            info_chip(ui, format!("Server port {}", inspect.server_port), AMBER);
            info_chip(
                ui,
                format!("Broad current {}", yes_no(inspect.status.broad_up_to_date)),
                BLUE,
            );
            info_chip(
                ui,
                format!(
                    "Mining current {}",
                    yes_no(inspect.status.mining_up_to_date)
                ),
                PINK,
            );
        });
        if !runtime.by_family.is_empty() {
            ui.add_space(16.0);
            ui.label(
                RichText::new("Active Runtime Families")
                    .strong()
                    .color(TEXT),
            );
            ui.add_space(8.0);
            family_grid(ui, &runtime.by_family);
        }
    }

    fn draw_progress(&self, ui: &mut egui::Ui) {
        let time = ui.input(|input| input.time);
        let (title, subtitle, waiting_title, waiting_detail) = match self.current_task {
            Some(TaskKind::Inspect) => (
                "Assessing current status",
                "Reading local universe state. No changes are made.",
                "Checking data",
                "Preparing a recommendation",
            ),
            Some(TaskKind::Seed) => (
                "Updating universe state",
                "Building definitions, applying runtime instances, then saving the result.",
                "Preparing update",
                "Starting the guided run",
            ),
            Some(TaskKind::ForceReseed) => (
                "Rebuilding universe state",
                "Force rebuild is running intentionally. Progress will stay visible here.",
                "Preparing rebuild",
                "Starting the full run",
            ),
            None => (
                "Working",
                "Progress will stay visible here until the task finishes.",
                "Standing by",
                "Waiting for the next event",
            ),
        };
        ui.label(RichText::new(title).size(18.0).strong().color(TEXT));
        ui.add_space(4.0);
        ui.label(RichText::new(subtitle).size(13.0).color(MUTED));
        ui.add_space(16.0);

        let Some(phase) = &self.phase else {
            empty_progress_state(ui, time, waiting_title, waiting_detail);
            ui.add_space(14.0);
            ui.label(
                RichText::new("When the check finishes, the next button appears here.")
                    .size(13.0)
                    .color(MUTED),
            );
            return;
        };

        let label = phase
            .label
            .clone()
            .unwrap_or_else(|| phase.phase.replace('_', " "));
        glossy_progress_bar(
            ui,
            phase.ratio.clamp(0.0, 1.0),
            &label,
            &format!(
                "{} / {} ({:.1}%)",
                phase.current,
                phase.total,
                phase.ratio * 100.0
            ),
            time,
        );
        ui.add_space(10.0);
        phase_rail(ui, phase.phase.as_str());
        ui.add_space(10.0);
        ui.horizontal_wrapped(|ui| {
            info_chip(ui, format!("Phase {}", phase_label(&phase.phase)), CYAN);
            if let Some(family) = &phase.family {
                info_chip(ui, format!("Family {}", family), GREEN);
            }
            if let Some(site_count) = phase.sites_built {
                info_chip(ui, format!("Sites built {}", site_count), AMBER);
            }
            if let Some(site_count) = phase.family_site_count {
                info_chip(ui, format!("Family output {}", site_count), PINK);
            }
        });
    }

    fn draw_summary(&mut self, ui: &mut egui::Ui) {
        let Some(summary) = &self.summary else {
            standby_message(
                ui,
                "No launch result yet",
                "Run Inspect or Seed Universe and the final result will appear here.",
            );
            return;
        };

        if summary.skipped.unwrap_or(false) {
            result_banner(
                ui,
                IconKind::Check,
                "Universe already current",
                &summary_reason(summary),
                GREEN,
            );
            if let Some(runtime_counts) = &summary.runtime_counts {
                ui.add_space(14.0);
                ui.horizontal_wrapped(|ui| {
                    info_chip(
                        ui,
                        format!("Runtime broad {}", runtime_counts.broad_count),
                        CYAN,
                    );
                    info_chip(
                        ui,
                        format!("Runtime mining {}", runtime_counts.generated_mining_count),
                        GREEN,
                    );
                });
            }
        } else {
            result_banner(
                ui,
                IconKind::Rocket,
                "Universe seed complete",
                "Runtime state and reconcile metadata were updated.",
                GREEN,
            );
            ui.add_space(14.0);
            ui.columns(4, |columns| {
                metric_card(
                    &mut columns[0],
                    "Desired Sites",
                    &summary.desired_site_count.unwrap_or(0).to_string(),
                    CYAN,
                );
                metric_card(
                    &mut columns[1],
                    "Created",
                    &summary.created_instances.unwrap_or(0).to_string(),
                    GREEN,
                );
                metric_card(
                    &mut columns[2],
                    "Replaced",
                    &summary.replaced_instances.unwrap_or(0).to_string(),
                    AMBER,
                );
                metric_card(
                    &mut columns[3],
                    "Elapsed",
                    &format!("{:.2}s", summary.elapsed_ms.unwrap_or(0) as f64 / 1000.0),
                    PINK,
                );
            });

            ui.add_space(14.0);
            ui.horizontal_wrapped(|ui| {
                info_chip(
                    ui,
                    format!("Systems: {}", summary.system_count.unwrap_or(0)),
                    CYAN,
                );
                info_chip(
                    ui,
                    format!("Retained: {}", summary.retained_instances.unwrap_or(0)),
                    GREEN,
                );
                info_chip(
                    ui,
                    format!("Removed: {}", summary.removed_instances.unwrap_or(0)),
                    AMBER,
                );
                info_chip(
                    ui,
                    format!(
                        "Mining rows +{} / -{}",
                        summary.mining_state_rows_created.unwrap_or(0),
                        summary.mining_state_rows_removed.unwrap_or(0)
                    ),
                    PINK,
                );
                if let Some(mining) = &summary.mining {
                    info_chip(
                        ui,
                        format!("Mining sites: {}", mining.desired_site_count),
                        BLUE,
                    );
                }
            });

            if let Some(families) = &summary.families {
                ui.add_space(10.0);
                ui.label(
                    RichText::new("Per-family Output")
                        .strong()
                        .size(16.0)
                        .color(TEXT),
                );
                ui.add_space(6.0);
                let total = families.len();
                for (family, details) in families.iter().take(MAX_VISIBLE_FAMILY_ROWS) {
                    let text = format!(
                        "{}  |  desired {}  |  systems {}  |  templates {}",
                        family,
                        details.desired_site_count,
                        details.systems_touched,
                        details.template_count
                    );
                    ui.label(
                        RichText::new(text)
                            .family(egui::FontFamily::Monospace)
                            .color(TEXT),
                    );
                }
                if total > MAX_VISIBLE_FAMILY_ROWS {
                    ui.add_space(6.0);
                    ui.label(
                        RichText::new(format!(
                            "Showing {} of {} families. Open Last Run Log for the full output.",
                            MAX_VISIBLE_FAMILY_ROWS, total
                        ))
                        .color(MUTED),
                    );
                }
            }
        }

        ui.add_space(18.0);
        ui.separator();
        ui.add_space(10.0);
        self.draw_option_row(ui);
    }

    fn draw_option_row(&mut self, ui: &mut egui::Ui) {
        let paths = self
            .repo
            .as_ref()
            .map(|repo| (repo.data_root.clone(), repo.tool_root.clone()));
        let enabled = !self.running;
        ui.horizontal_wrapped(|ui| {
            if icon_link(ui, IconKind::Scan, "Check Again", CYAN).clicked() && enabled {
                self.start_task(TaskKind::Inspect);
            }
            if icon_link(ui, IconKind::Bolt, "Force Rebuild", AMBER).clicked() && enabled {
                self.start_task(TaskKind::ForceReseed);
            }
            if let Some((data_root, tool_root)) = &paths {
                if icon_link(ui, IconKind::Database, "Data Folder", BLUE).clicked() {
                    Self::open_path(Path::new(data_root), false);
                }
                if icon_link(ui, IconKind::Folder, "Tool Folder", GREEN).clicked() {
                    Self::open_path(Path::new(tool_root), false);
                }
            }
            let run_log_enabled = self.run_log_path.as_ref().is_some_and(|path| path.exists());
            let log_response = ui.add_enabled_ui(run_log_enabled, |ui| {
                icon_link(ui, IconKind::Log, "Last Log", PINK)
            });
            if log_response.inner.clicked() {
                if let Some(path) = &self.run_log_path {
                    Self::open_path(path, false);
                }
            }
        });
    }

    fn draw_logs(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            paint_icon_inline(ui, IconKind::Log, CYAN);
            ui.vertical(|ui| {
                ui.label(
                    RichText::new("Event Console")
                        .size(18.0)
                        .strong()
                        .color(TEXT),
                );
                ui.label(
                    RichText::new("Live seeder output with the newest lines kept in view.")
                        .size(13.0)
                        .color(MUTED),
                );
            });
        });
        ui.add_space(12.0);
        let total = self.logs.len();
        let start = total.saturating_sub(MAX_VISIBLE_LOG_ENTRIES);
        Frame::new()
            .fill(Color32::from_rgb(250, 252, 255))
            .stroke(Stroke::new(1.0, LINE))
            .corner_radius(CornerRadius::same(14))
            .inner_margin(Margin::same(12))
            .show(ui, |ui| {
                for entry in self.logs.iter().skip(start) {
                    let color = match entry.level.as_str() {
                        "error" => Color32::from_rgb(210, 56, 72),
                        "success" => GREEN,
                        "warn" => AMBER,
                        _ => MUTED,
                    };
                    ui.label(
                        RichText::new(format!(
                            "[{}] {}",
                            entry.level.to_uppercase(),
                            entry.message
                        ))
                        .family(egui::FontFamily::Monospace)
                        .size(12.0)
                        .color(color),
                    );
                }
                if total == 0 {
                    ui.label(
                        RichText::new("Console is standing by.")
                            .family(egui::FontFamily::Monospace)
                            .size(12.0)
                            .color(MUTED),
                    );
                }
            });
        if total > MAX_VISIBLE_LOG_ENTRIES {
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!(
                    "Showing last {} of {} log lines. Open Last Run Log for full output.",
                    MAX_VISIBLE_LOG_ENTRIES, total
                ))
                .color(MUTED),
            );
        }
    }
}

impl eframe::App for UniverseSeederApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_messages();
        ctx.request_repaint_after(Duration::from_millis(33));
        let time = ctx.input(|input| input.time);
        let splash_elapsed = self.splash_started_at.elapsed().as_secs_f32();

        egui::CentralPanel::default()
            .frame(
                Frame::new()
                    .fill(BG)
                    .inner_margin(Margin::symmetric(18, 16)),
            )
            .show(ctx, |ui| {
                paint_app_backdrop(ui, ui.max_rect(), time);
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        self.draw_header(ui);
                        ui.add_space(16.0);
                        if self.running {
                            glass_panel(ui, |ui| {
                                self.draw_progress(ui);
                            });
                        } else if self.summary.is_some() {
                            glass_panel(ui, |ui| {
                                self.draw_summary(ui);
                            });
                        } else {
                            self.draw_guided_focus(ui);
                        }
                        ui.add_space(16.0);
                        egui::CollapsingHeader::new("Technical details")
                            .default_open(false)
                            .show(ui, |ui| {
                                ui.add_space(8.0);
                                glass_panel(ui, |ui| self.draw_metrics(ui));
                            });
                        ui.add_space(10.0);
                        egui::CollapsingHeader::new("Run log")
                            .default_open(false)
                            .show(ui, |ui| {
                                ui.add_space(8.0);
                                glass_panel(ui, |ui| self.draw_logs(ui));
                            });
                    });
            });

        if splash_elapsed < SPLASH_TOTAL_SECONDS {
            paint_launch_splash(ctx, splash_elapsed);
            ctx.request_repaint_after(Duration::from_millis(16));
        }
    }
}

fn paint_launch_splash(ctx: &egui::Context, elapsed: f32) {
    let rect = ctx.screen_rect();
    let painter = ctx.layer_painter(egui::LayerId::new(
        egui::Order::Foreground,
        egui::Id::new("john_elysian_launch_splash"),
    ));

    let fade_out = smoothstep(3.55, SPLASH_TOTAL_SECONDS, elapsed);
    let overlay_alpha = 1.0 - fade_out;
    if overlay_alpha <= 0.01 {
        return;
    }

    painter.rect_filled(
        rect,
        CornerRadius::same(0),
        Color32::from_rgba_unmultiplied(255, 255, 255, alpha_byte(overlay_alpha)),
    );

    let headline = splash_headline(elapsed);
    let cursor_visible = elapsed < 3.28 && ((elapsed * 3.2).fract() < 0.58);
    let cursor = if cursor_visible { "|" } else { "" };
    let text_alpha = overlay_alpha * smoothstep(0.12, 0.42, elapsed);
    let scale_in = 0.985 + smoothstep(0.0, 0.7, elapsed) * 0.015;
    let center = rect.center();
    let headline_size = 70.0 * scale_in;

    painter.text(
        center + Vec2::new(0.0, -18.0),
        Align2::CENTER_CENTER,
        format!("{}{}", headline, cursor),
        FontId::proportional(headline_size),
        Color32::from_rgba_unmultiplied(0, 0, 0, alpha_byte(text_alpha)),
    );

    let caption_alpha = overlay_alpha * smoothstep(2.78, 3.22, elapsed);
    painter.text(
        center + Vec2::new(0.0, 58.0),
        Align2::CENTER_CENTER,
        "UNIVERSE SITE SEEDER",
        FontId::proportional(14.0),
        Color32::from_rgba_unmultiplied(0, 0, 0, alpha_byte(caption_alpha * 0.48)),
    );
}

fn splash_headline(elapsed: f32) -> String {
    const NAME: &str = "John Elysian";
    const PRESENTS: &str = "Presents....";

    let name_len = NAME.chars().count();
    let presents_len = PRESENTS.chars().count();

    if elapsed < 1.08 {
        let count = (smoothstep(0.12, 1.08, elapsed) * name_len as f32).ceil() as usize;
        return take_chars(NAME, count.max(1));
    }

    if elapsed < 1.54 {
        return NAME.to_string();
    }

    if elapsed < 2.10 {
        let erased = (smoothstep(1.54, 2.10, elapsed) * name_len as f32).floor() as usize;
        return take_chars(NAME, name_len.saturating_sub(erased));
    }

    if elapsed < 3.05 {
        let count = (smoothstep(2.10, 3.05, elapsed) * presents_len as f32).ceil() as usize;
        return take_chars(PRESENTS, count.max(1));
    }

    PRESENTS.to_string()
}

fn take_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

fn alpha_byte(alpha: f32) -> u8 {
    (alpha.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn smoothstep(start: f32, end: f32, value: f32) -> f32 {
    if end <= start {
        return if value >= end { 1.0 } else { 0.0 };
    }
    let t = ((value - start) / (end - start)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn glass_panel<R>(ui: &mut egui::Ui, add_contents: impl FnOnce(&mut egui::Ui) -> R) -> R {
    Frame::new()
        .fill(PANEL)
        .stroke(Stroke::new(1.0, LINE))
        .corner_radius(CornerRadius::same(24))
        .inner_margin(Margin::same(18))
        .show(ui, |ui| add_contents(ui))
        .inner
}

#[derive(Clone, Copy)]
enum IconKind {
    Scan,
    Rocket,
    Bolt,
    Database,
    Folder,
    Log,
    Check,
}

fn metric_card(ui: &mut egui::Ui, title: &str, value: &str, accent: Color32) {
    Frame::new()
        .fill(PANEL_SOFT)
        .stroke(Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 72),
        ))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::same(14))
        .show(ui, |ui| {
            ui.label(RichText::new(title).size(12.0).strong().color(MUTED));
            ui.add_space(8.0);
            ui.label(RichText::new(value).size(22.0).strong().color(accent));
        });
}

fn info_chip(ui: &mut egui::Ui, text: String, accent: Color32) {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(
            accent.r(),
            accent.g(),
            accent.b(),
            22,
        ))
        .stroke(Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 98),
        ))
        .corner_radius(CornerRadius::same(14))
        .inner_margin(Margin::symmetric(11, 6))
        .show(ui, |ui| {
            ui.label(RichText::new(text).size(12.0).strong().color(accent));
        });
}

fn small_pill(ui: &mut egui::Ui, text: &str, accent: Color32) {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(
            accent.r(),
            accent.g(),
            accent.b(),
            24,
        ))
        .stroke(Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 118),
        ))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(12, 6))
        .show(ui, |ui| {
            ui.label(RichText::new(text).size(12.0).strong().color(accent));
        });
}

fn path_strip(ui: &mut egui::Ui, label: &str, value: &str) {
    Frame::new()
        .fill(PANEL_SOFT)
        .stroke(Stroke::new(1.0, LINE))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::symmetric(14, 10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                paint_icon_inline(ui, IconKind::Folder, CYAN);
                ui.vertical(|ui| {
                    ui.label(RichText::new(label).size(12.0).strong().color(MUTED));
                    ui.label(
                        RichText::new(value)
                            .size(13.0)
                            .family(egui::FontFamily::Monospace)
                            .color(TEXT),
                    );
                });
            });
        });
}

fn family_grid(ui: &mut egui::Ui, families: &std::collections::BTreeMap<String, u64>) {
    let available = ui.available_width().max(360.0);
    let columns = if available >= 1420.0 {
        5
    } else if available >= 1040.0 {
        4
    } else {
        3
    };
    let gap = 10.0;
    let cell_width = ((available - gap * (columns as f32 - 1.0)) / columns as f32).floor();
    let row_height = 34.0;
    let entries: Vec<_> = families.iter().collect();
    let rows = (entries.len() + columns - 1) / columns;

    for row in 0..rows {
        ui.horizontal(|ui| {
            for column in 0..columns {
                let index = row * columns + column;
                if column > 0 {
                    ui.add_space(gap);
                }
                let (rect, _) =
                    ui.allocate_exact_size(Vec2::new(cell_width, row_height), Sense::hover());
                if let Some((family, count)) = entries.get(index) {
                    paint_family_cell(ui, rect, family, **count);
                }
            }
        });
        if row + 1 < rows {
            ui.add_space(8.0);
        }
    }
}

fn paint_family_cell(ui: &egui::Ui, rect: Rect, family: &str, count: u64) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(12), PANEL);
    painter.rect(
        rect,
        CornerRadius::same(12),
        Color32::TRANSPARENT,
        Stroke::new(1.0, LINE),
        StrokeKind::Outside,
    );
    let label_width = (rect.width() - 72.0).max(60.0);
    let label_chars = (label_width / 7.0).floor().max(8.0) as usize;
    let label = truncate_tail(&family.replace('_', " "), label_chars);
    painter.text(
        Pos2::new(rect.left() + 12.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(12.0),
        TEXT,
    );
    painter.text(
        Pos2::new(rect.right() - 12.0, rect.center().y),
        Align2::RIGHT_CENTER,
        count.to_string(),
        FontId::proportional(12.0),
        CYAN,
    );
}

fn truncate_tail(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    if max_chars <= 3 {
        return "...".to_string();
    }
    let mut output: String = value.chars().take(max_chars - 3).collect();
    output.push_str("...");
    output
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn summary_reason(summary: &SummaryEvent) -> String {
    match summary.reason.as_deref() {
        Some("already_current") => {
            "The saved universe already matches the current descriptor.".to_string()
        }
        Some(reason) => reason.replace('_', " "),
        None => "No writes were needed.".to_string(),
    }
}

fn friendly_error(error: &str) -> (&'static str, String, &'static str) {
    let lower = error.to_lowercase();
    if lower.contains("game server appears to be running") {
        return (
            "Stop the running server first",
            "The seeder paused because the game server is using the live data port.".to_string(),
            "Close the server, then run the check again.",
        );
    }
    if lower.contains("node") {
        return (
            "Node.js is needed",
            "The seeder engine runs through Node.js, and Windows could not launch it.".to_string(),
            "Install Node.js or make sure it is available on PATH, then check again.",
        );
    }
    if lower.contains("repo root") {
        return (
            "Open this inside EvEJS",
            "The app could not find the EvEJS data tables from its current location.".to_string(),
            "Keep the tool inside the EvEJS checkout, then run the check again.",
        );
    }
    (
        "The check paused",
        error.to_string(),
        "Open the run log for details, then try the check again.",
    )
}

fn phase_label(value: &str) -> &'static str {
    match value {
        "build_mining" => "Mining definitions",
        "build_broad" => "Family definitions",
        "apply_instances" => "Dungeon instances",
        "apply_mining_rows" => "Mining rows",
        _ => "Preparing",
    }
}

fn standby_message(ui: &mut egui::Ui, title: &str, body: &str) {
    Frame::new()
        .fill(PANEL_SOFT)
        .stroke(Stroke::new(1.0, LINE))
        .corner_radius(CornerRadius::same(18))
        .inner_margin(Margin::same(16))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                paint_icon_inline(ui, IconKind::Scan, CYAN);
                ui.vertical(|ui| {
                    ui.label(RichText::new(title).size(16.0).strong().color(TEXT));
                    ui.label(RichText::new(body).size(13.0).color(MUTED));
                });
            });
        });
}

fn setup_focus(
    ui: &mut egui::Ui,
    icon: IconKind,
    title: &str,
    body: &str,
    detail: &str,
    cta: Option<(&str, &str)>,
    accent: Color32,
) -> Option<egui::Response> {
    let time = ui.input(|input| input.time);
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 284.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(24), PANEL);
    painter.rect(
        rect,
        CornerRadius::same(24),
        Color32::TRANSPARENT,
        Stroke::new(1.0, LINE),
        StrokeKind::Outside,
    );
    let glow = Rect::from_min_max(
        Pos2::new(rect.left(), rect.bottom() - 74.0),
        Pos2::new(rect.right(), rect.bottom()),
    );
    painter.rect_filled(
        glow,
        CornerRadius::same(24),
        Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 13),
    );

    let orbit_center = Pos2::new(rect.right() - 96.0, rect.top() + 82.0);
    let orbit_angle = time as f32 * 0.55;
    for radius in [31.0, 52.0, 74.0] {
        painter.circle_stroke(
            orbit_center,
            radius,
            Stroke::new(
                1.0,
                Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 34),
            ),
        );
    }
    let satellite = Pos2::new(
        orbit_center.x + orbit_angle.cos() * 74.0,
        orbit_center.y + orbit_angle.sin() * 38.0,
    );
    painter.circle_filled(satellite, 3.5, accent);

    let icon_center = Pos2::new(rect.left() + 72.0, rect.top() + 88.0);
    painter.circle_filled(
        icon_center,
        40.0,
        Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 24),
    );
    painter.circle_stroke(
        icon_center,
        40.0,
        Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 86),
        ),
    );
    paint_icon(painter, icon, icon_center, 24.0, accent);

    let mut cta_response = None;
    let text_rect = Rect::from_min_max(
        Pos2::new(rect.left() + 132.0, rect.top() + 42.0),
        Pos2::new(rect.right() - 170.0, rect.bottom() - 34.0),
    );
    ui.scope_builder(egui::UiBuilder::new().max_rect(text_rect), |ui| {
        ui.set_width(text_rect.width());
        ui.add(egui::Label::new(RichText::new(title).size(31.0).strong().color(TEXT)).wrap());
        ui.add_space(10.0);
        ui.add(egui::Label::new(RichText::new(body).size(16.0).color(MUTED)).wrap());
        ui.add_space(6.0);
        ui.add(egui::Label::new(RichText::new(detail).size(13.0).color(MUTED)).wrap());
        ui.add_space(28.0);
        if let Some((label, sublabel)) = cta {
            cta_response = Some(primary_cta(ui, label, sublabel, accent));
        } else {
            assistant_loader(ui, accent, time);
        }
    });
    ui.advance_cursor_after_rect(rect);
    cta_response
}

fn primary_cta(ui: &mut egui::Ui, label: &str, sublabel: &str, accent: Color32) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(246.0, 56.0), Sense::click());
    let painter = ui.painter();
    let fill = if response.hovered() {
        Color32::from_rgb(0, 103, 224)
    } else {
        accent
    };
    painter.rect_filled(rect, CornerRadius::same(18), fill);
    painter.rect(
        rect,
        CornerRadius::same(18),
        Color32::TRANSPARENT,
        Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 255, 255, 92)),
        StrokeKind::Inside,
    );
    painter.text(
        Pos2::new(rect.left() + 20.0, rect.top() + 11.0),
        Align2::LEFT_TOP,
        label,
        FontId::proportional(16.0),
        Color32::WHITE,
    );
    painter.text(
        Pos2::new(rect.left() + 20.0, rect.top() + 32.0),
        Align2::LEFT_TOP,
        sublabel,
        FontId::proportional(11.5),
        Color32::from_rgba_unmultiplied(255, 255, 255, 210),
    );
    response
}

fn assistant_loader(ui: &mut egui::Ui, accent: Color32, time: f64) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(250.0, 44.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(
        rect,
        CornerRadius::same(18),
        Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 17),
    );
    painter.rect(
        rect,
        CornerRadius::same(18),
        Color32::TRANSPARENT,
        Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 70),
        ),
        StrokeKind::Outside,
    );
    for index in 0..3 {
        let pulse = ((time as f32 * 2.4) + index as f32 * 0.82).sin() * 0.5 + 0.5;
        painter.circle_filled(
            Pos2::new(rect.left() + 22.0 + index as f32 * 15.0, rect.center().y),
            3.2 + pulse * 1.4,
            Color32::from_rgba_unmultiplied(
                accent.r(),
                accent.g(),
                accent.b(),
                (110.0 + pulse * 115.0) as u8,
            ),
        );
    }
    painter.text(
        Pos2::new(rect.left() + 76.0, rect.center().y),
        Align2::LEFT_CENTER,
        "Assessing local state",
        FontId::proportional(13.0),
        accent,
    );
}

fn icon_link(ui: &mut egui::Ui, icon: IconKind, label: &str, accent: Color32) -> egui::Response {
    let enabled = ui.is_enabled();
    let (rect, response) = ui.allocate_exact_size(Vec2::new(152.0, 46.0), Sense::click());
    let hovered = response.hovered() && enabled;
    let painter = ui.painter();
    painter.rect_filled(
        rect,
        CornerRadius::same(16),
        if hovered {
            Color32::from_rgb(246, 250, 255)
        } else {
            PANEL
        },
    );
    painter.rect(
        rect,
        CornerRadius::same(16),
        Color32::TRANSPARENT,
        Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 95),
        ),
        StrokeKind::Outside,
    );
    paint_icon(
        painter,
        icon,
        Pos2::new(rect.left() + 24.0, rect.center().y),
        14.0,
        if enabled { accent } else { MUTED },
    );
    painter.text(
        Pos2::new(rect.left() + 46.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(13.0),
        if enabled { TEXT } else { MUTED },
    );
    response
}

fn paint_icon_inline(ui: &mut egui::Ui, icon: IconKind, accent: Color32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::hover());
    let center = rect.center();
    let painter = ui.painter();
    painter.circle_filled(
        center,
        16.0,
        Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 26),
    );
    paint_icon(painter, icon, center, 12.0, accent);
}

fn paint_icon(painter: &egui::Painter, icon: IconKind, center: Pos2, size: f32, color: Color32) {
    let stroke = Stroke::new(1.6, color);
    match icon {
        IconKind::Scan => {
            painter.circle_stroke(center + Vec2::new(-2.0, -2.0), size * 0.46, stroke);
            painter.line_segment(
                [
                    center + Vec2::new(size * 0.25, size * 0.25),
                    center + Vec2::new(size * 0.65, size * 0.65),
                ],
                stroke,
            );
        }
        IconKind::Rocket => {
            painter.line_segment(
                [
                    center + Vec2::new(0.0, -size),
                    center + Vec2::new(size * 0.56, size * 0.35),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    center + Vec2::new(0.0, -size),
                    center + Vec2::new(-size * 0.56, size * 0.35),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    center + Vec2::new(-size * 0.56, size * 0.35),
                    center + Vec2::new(size * 0.56, size * 0.35),
                ],
                stroke,
            );
            painter.circle_stroke(center + Vec2::new(0.0, -size * 0.18), size * 0.18, stroke);
            painter.line_segment(
                [
                    center + Vec2::new(-size * 0.24, size * 0.42),
                    center + Vec2::new(-size * 0.42, size * 0.9),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    center + Vec2::new(size * 0.24, size * 0.42),
                    center + Vec2::new(size * 0.42, size * 0.9),
                ],
                stroke,
            );
        }
        IconKind::Bolt => {
            let points = vec![
                center + Vec2::new(size * 0.18, -size),
                center + Vec2::new(-size * 0.52, size * 0.12),
                center + Vec2::new(-size * 0.08, size * 0.12),
                center + Vec2::new(-size * 0.22, size),
                center + Vec2::new(size * 0.54, -size * 0.18),
                center + Vec2::new(size * 0.1, -size * 0.18),
            ];
            painter.add(egui::Shape::closed_line(points, stroke));
        }
        IconKind::Database => {
            for offset in [-0.48, 0.0, 0.48] {
                let y = center.y + offset * size;
                let rect = Rect::from_center_size(
                    Pos2::new(center.x, y),
                    Vec2::new(size * 1.15, size * 0.42),
                );
                painter.rect_stroke(rect, CornerRadius::same(7), stroke, StrokeKind::Outside);
            }
        }
        IconKind::Folder => {
            let rect = Rect::from_center_size(
                center + Vec2::new(0.0, size * 0.1),
                Vec2::new(size * 1.45, size * 0.9),
            );
            painter.rect_stroke(rect, CornerRadius::same(5), stroke, StrokeKind::Outside);
            painter.line_segment(
                [
                    rect.left_top() + Vec2::new(size * 0.12, 0.0),
                    rect.left_top() + Vec2::new(size * 0.45, -size * 0.25),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    rect.left_top() + Vec2::new(size * 0.45, -size * 0.25),
                    rect.left_top() + Vec2::new(size * 0.82, 0.0),
                ],
                stroke,
            );
        }
        IconKind::Log => {
            let rect = Rect::from_center_size(center, Vec2::new(size * 1.25, size * 1.45));
            painter.rect_stroke(rect, CornerRadius::same(5), stroke, StrokeKind::Outside);
            for i in 0..3 {
                let y = rect.top() + size * 0.4 + i as f32 * size * 0.32;
                painter.line_segment(
                    [
                        Pos2::new(rect.left() + size * 0.28, y),
                        Pos2::new(rect.right() - size * 0.22, y),
                    ],
                    stroke,
                );
            }
        }
        IconKind::Check => {
            painter.circle_stroke(center, size * 0.78, stroke);
            painter.line_segment(
                [
                    center + Vec2::new(-size * 0.38, 0.0),
                    center + Vec2::new(-size * 0.1, size * 0.3),
                ],
                stroke,
            );
            painter.line_segment(
                [
                    center + Vec2::new(-size * 0.1, size * 0.3),
                    center + Vec2::new(size * 0.46, -size * 0.34),
                ],
                stroke,
            );
        }
    }
}

fn paint_app_backdrop(ui: &egui::Ui, rect: Rect, time: f64) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(0), BG);
    for i in 0..20 {
        let x_seed = ((i * 73) % 1000) as f32 / 1000.0;
        let y_seed = ((i * 191) % 1000) as f32 / 1000.0;
        let pulse = ((time as f32 * 0.55) + i as f32 * 0.37).sin() * 0.5 + 0.5;
        let pos = Pos2::new(
            rect.left() + rect.width() * x_seed,
            rect.top() + rect.height() * y_seed,
        );
        painter.circle_filled(
            pos,
            0.7 + pulse * 0.45,
            Color32::from_rgba_unmultiplied(
                CYAN.r(),
                CYAN.g(),
                CYAN.b(),
                (9.0 + pulse * 16.0) as u8,
            ),
        );
    }
}

fn paint_clean_hero(ui: &egui::Ui, rect: Rect, time: f64, running: bool) {
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(24), PANEL);
    painter.rect(
        rect,
        CornerRadius::same(24),
        Color32::TRANSPARENT,
        Stroke::new(1.0, LINE),
        StrokeKind::Outside,
    );

    let glow = Rect::from_min_max(
        Pos2::new(rect.left(), rect.bottom() - 56.0),
        Pos2::new(rect.right(), rect.bottom()),
    );
    painter.rect_filled(
        glow,
        CornerRadius::same(24),
        Color32::from_rgba_unmultiplied(CYAN.r(), CYAN.g(), CYAN.b(), 14),
    );

    let orbit_center = Pos2::new(rect.right() - 154.0, rect.center().y + 4.0);
    for radius in [42.0, 72.0, 101.0] {
        painter.circle_stroke(
            orbit_center,
            radius,
            Stroke::new(
                1.0,
                Color32::from_rgba_unmultiplied(CYAN.r(), CYAN.g(), CYAN.b(), 36),
            ),
        );
    }
    let radius = if running { 72.0 } else { 54.0 };
    let angle = time as f32 * if running { 1.25 } else { 0.38 };
    let satellite = Pos2::new(
        orbit_center.x + angle.cos() * radius,
        orbit_center.y + angle.sin() * radius * 0.55,
    );
    painter.circle_filled(satellite, 3.6, if running { GREEN } else { CYAN });
    painter.circle_filled(
        orbit_center,
        25.0,
        Color32::from_rgba_unmultiplied(CYAN.r(), CYAN.g(), CYAN.b(), 18),
    );
    painter.circle_stroke(
        orbit_center,
        25.0,
        Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(CYAN.r(), CYAN.g(), CYAN.b(), 86),
        ),
    );
    paint_icon(painter, IconKind::Rocket, orbit_center, 16.0, CYAN);
}

fn paint_status_card(
    ui: &egui::Ui,
    rect: Rect,
    time: f64,
    label: &str,
    fill: Color32,
    text: Color32,
) {
    let painter = ui.painter();
    painter.rect_filled(
        rect,
        CornerRadius::same(20),
        Color32::from_rgb(250, 252, 255),
    );
    painter.rect(
        rect,
        CornerRadius::same(20),
        Color32::TRANSPARENT,
        Stroke::new(1.0, LINE),
        StrokeKind::Outside,
    );

    let center = Pos2::new(rect.left() + 48.0, rect.center().y);
    let pulse = ((time as f32 * 1.6).sin() + 1.0) * 0.5;
    painter.circle_stroke(
        center,
        28.0 + pulse * 2.0,
        Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(text.r(), text.g(), text.b(), 70),
        ),
    );
    painter.circle_filled(center, 22.0, fill);
    paint_icon(painter, IconKind::Check, center, 13.0, text);
    painter.text(
        Pos2::new(rect.left() + 90.0, rect.top() + 31.0),
        Align2::LEFT_TOP,
        "Current Status",
        FontId::proportional(12.0),
        MUTED,
    );
    painter.text(
        Pos2::new(rect.left() + 90.0, rect.top() + 54.0),
        Align2::LEFT_TOP,
        label,
        FontId::proportional(19.0),
        text,
    );
    painter.text(
        Pos2::new(rect.left() + 90.0, rect.top() + 88.0),
        Align2::LEFT_TOP,
        "Ready for the next step.",
        FontId::proportional(12.5),
        MUTED,
    );
}

fn result_banner(ui: &mut egui::Ui, icon: IconKind, title: &str, body: &str, accent: Color32) {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(
            accent.r(),
            accent.g(),
            accent.b(),
            18,
        ))
        .stroke(Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 82),
        ))
        .corner_radius(CornerRadius::same(18))
        .inner_margin(Margin::same(16))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                paint_icon_inline(ui, icon, accent);
                ui.vertical(|ui| {
                    ui.label(RichText::new(title).size(18.0).strong().color(TEXT));
                    ui.label(RichText::new(body).size(13.0).color(MUTED));
                });
            });
        });
}

fn glossy_progress_bar(ui: &mut egui::Ui, ratio: f32, title: &str, detail: &str, time: f64) {
    ui.label(RichText::new(title).size(18.0).strong().color(TEXT));
    ui.add_space(10.0);
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 38.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(
        rect,
        CornerRadius::same(19),
        Color32::from_rgb(238, 243, 250),
    );
    painter.rect(
        rect,
        CornerRadius::same(19),
        Color32::TRANSPARENT,
        Stroke::new(1.0, LINE),
        StrokeKind::Outside,
    );

    let fill_width =
        (rect.width() * ratio.clamp(0.0, 1.0)).max(if ratio > 0.0 { 12.0 } else { 0.0 });
    if fill_width > 0.0 {
        let fill_rect = Rect::from_min_size(rect.min, Vec2::new(fill_width, rect.height()));
        painter.rect_filled(fill_rect, CornerRadius::same(19), CYAN);
        let sheen_x = rect.left() + ((time as f32 * 132.0) % (rect.width() + 100.0)) - 100.0;
        painter.rect_filled(
            Rect::from_min_size(
                Pos2::new(sheen_x, rect.top()),
                Vec2::new(72.0, rect.height()),
            ),
            CornerRadius::same(19),
            Color32::from_rgba_unmultiplied(255, 255, 255, 72),
        );
        painter.rect_filled(
            Rect::from_min_max(
                fill_rect.left_top(),
                Pos2::new(fill_rect.right(), fill_rect.top() + 11.0),
            ),
            CornerRadius::same(19),
            Color32::from_rgba_unmultiplied(255, 255, 255, 52),
        );
    }
    painter.text(
        rect.center(),
        Align2::CENTER_CENTER,
        detail,
        FontId::proportional(14.0),
        TEXT,
    );
}

fn empty_progress_state(ui: &mut egui::Ui, time: f64, title: &str, detail: &str) {
    glossy_progress_bar(
        ui,
        0.07 + ((time.sin() as f32 + 1.0) * 0.012),
        title,
        detail,
        time,
    );
}

fn phase_rail(ui: &mut egui::Ui, active: &str) {
    let phases = [
        ("build_mining", "Mining"),
        ("build_broad", "Families"),
        ("apply_instances", "Instances"),
        ("apply_mining_rows", "Rows"),
    ];
    let active_index = phases
        .iter()
        .position(|(key, _)| *key == active)
        .unwrap_or(0);
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 58.0), Sense::hover());
    let painter = ui.painter();
    let y = rect.top() + 20.0;
    painter.line_segment(
        [
            Pos2::new(rect.left() + 22.0, y),
            Pos2::new(rect.right() - 22.0, y),
        ],
        Stroke::new(1.0, LINE),
    );
    let step = if phases.len() > 1 {
        (rect.width() - 44.0) / (phases.len() as f32 - 1.0)
    } else {
        0.0
    };
    for (index, (_, label)) in phases.iter().enumerate() {
        let x = rect.left() + 22.0 + index as f32 * step;
        let accent = if index < active_index {
            GREEN
        } else if index == active_index {
            CYAN
        } else {
            MUTED
        };
        painter.circle_filled(
            Pos2::new(x, y),
            if index == active_index { 7.0 } else { 5.0 },
            accent,
        );
        painter.text(
            Pos2::new(x, y + 16.0),
            Align2::CENTER_TOP,
            *label,
            FontId::proportional(11.0),
            accent,
        );
    }
}

fn run_cli_health_check() -> Result<()> {
    let repo_root = UniverseSeederApp::resolve_repo_root()
        .ok_or_else(|| anyhow!("Could not find an EvEJS checkout from this folder."))?;
    let tool_root = UniverseSeederApp::tool_root()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| anyhow!("Could not find the seeder app folder."))?;
    let runtime = materialize_embedded_runtime()?;
    let status = Command::new("node")
        .arg(&runtime.script_path)
        .arg("--inspect")
        .arg("--force-live")
        .current_dir(&repo_root)
        .env("EVEJS_REPO_ROOT", &repo_root)
        .env("UNIVERSE_SEEDER_TOOL_ROOT", &tool_root)
        .status()
        .with_context(|| "Failed to launch node. Make sure Node.js is installed and on PATH.")?;

    if !status.success() {
        return Err(anyhow!(
            "Read-only health check exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }

    println!("Elysian Universe Site Seeder health check passed.");
    Ok(())
}

fn run_seed_process(
    repo_root: &Path,
    tool_root: &Path,
    task: TaskKind,
    sender: Sender<ToolMessage>,
) -> Result<()> {
    let runtime = materialize_embedded_runtime()?;
    let mut command = Command::new("node");
    command
        .arg(&runtime.script_path)
        .arg("--progress-json")
        .current_dir(repo_root)
        .env("EVEJS_REPO_ROOT", repo_root)
        .env("UNIVERSE_SEEDER_TOOL_ROOT", tool_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match task {
        TaskKind::Inspect => {
            command.arg("--inspect");
        }
        TaskKind::Seed => {
            command.arg("--seed");
        }
        TaskKind::ForceReseed => {
            command.arg("--force-reseed-universe");
        }
    }

    let mut child = command
        .spawn()
        .with_context(|| "Failed to launch node. Make sure Node.js is installed and on PATH.")?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Failed to capture seeder stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture seeder stderr"))?;

    let stdout_sender = sender.clone();
    let stdout_thread = thread::spawn(move || -> Result<()> {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = line?;
            handle_output_line(&stdout_sender, &line);
        }
        Ok(())
    });

    let stderr_sender = sender.clone();
    let stderr_thread = thread::spawn(move || -> Result<()> {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = line?;
            let _ = stderr_sender.send(ToolMessage::Log(LogEntry {
                level: "error".to_string(),
                message: line,
            }));
        }
        Ok(())
    });

    let status = child.wait()?;
    stdout_thread
        .join()
        .map_err(|_| anyhow!("stdout reader thread panicked"))??;
    stderr_thread
        .join()
        .map_err(|_| anyhow!("stderr reader thread panicked"))??;

    if !status.success() {
        return Err(anyhow!(
            "Seeder exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

fn handle_output_line(sender: &Sender<ToolMessage>, line: &str) {
    const PREFIX: &str = "SEEDER_EVENT ";
    if let Some(payload) = line.strip_prefix(PREFIX) {
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            let event_type = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match event_type.as_str() {
                "repo" => {
                    if let Ok(event) = serde_json::from_value::<RepoEvent>(value.clone()) {
                        let _ = sender.send(ToolMessage::Repo(event));
                    }
                }
                "inspect" => {
                    if let Ok(event) = serde_json::from_value::<InspectEvent>(value.clone()) {
                        let _ = sender.send(ToolMessage::Inspect(event));
                    }
                }
                "phase" => {
                    if let Ok(event) = serde_json::from_value::<PhaseEvent>(value.clone()) {
                        let _ = sender.send(ToolMessage::Phase(event));
                    }
                }
                "summary" => {
                    if let Some(summary) = value.get("summary") {
                        if let Ok(event) = serde_json::from_value::<SummaryEvent>(summary.clone()) {
                            let _ = sender.send(ToolMessage::Summary(event));
                        }
                    }
                }
                "log" => {
                    let level = value
                        .get("level")
                        .and_then(Value::as_str)
                        .unwrap_or("info")
                        .to_string();
                    let message = value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let _ = sender.send(ToolMessage::Log(LogEntry { level, message }));
                }
                "error" => {
                    let message = value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown seeder error")
                        .to_string();
                    let _ = sender.send(ToolMessage::Log(LogEntry {
                        level: "error".to_string(),
                        message,
                    }));
                }
                _ => {}
            }
            return;
        }
    }

    let _ = sender.send(ToolMessage::Log(LogEntry {
        level: "info".to_string(),
        message: line.to_string(),
    }));
}
