mod types;

use std::fs::{self};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::cache;
use crate::http_client;
use crate::managed_resources;

pub use types::{
    NativeCliFailureKind, NativeCliProgress, NativeCliProgressPhase, NativeCliProgressReporter, NativeCliRuntimeKind,
    NativeCliToolError, NativeCliToolId, NativeCliToolSupport, ResolvedNativeCliTool, SharedNativeCliProgressReporter,
};

const NATIVE_CLI_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const NATIVE_CLI_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const NATIVE_CLI_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const NATIVE_CLI_DOWNLOAD_ATTEMPTS: usize = 2;
const NATIVE_CLI_PROGRESS_STEP_BYTES: u64 = 5 * 1024 * 1024;

static INSTALL_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy)]
struct PlatformSpec {
    manifest_key: &'static str,
    archive_ext: &'static str,
}

impl PlatformSpec {
    fn download_url(self, tool: NativeCliToolId) -> String {
        format!(
            "https://github.com/halojerry/poundingcore/releases/download/native-cli-{slug}-v{version}/{slug}-{platform}.{ext}",
            slug = tool.slug(),
            version = tool.version(),
            platform = self.manifest_key,
            ext = self.archive_ext,
        )
    }
}

#[derive(Debug, Clone)]
struct NativeCliDownloadSource {
    url: String,
    sha256: Option<String>,
}

impl NativeCliDownloadSource {
    fn official(tool: NativeCliToolId, spec: PlatformSpec) -> Self {
        Self {
            url: spec.download_url(tool),
            sha256: None,
        }
    }
}

pub fn probe_native_cli_tool_supported(tool: NativeCliToolId) -> NativeCliToolSupport {
    match platform_spec() {
        Ok(spec) => NativeCliToolSupport {
            supported: true,
            detail: format!(
                "native CLI {} supported under platform {}",
                tool.display_name(),
                spec.manifest_key
            ),
        },
        Err(error) => NativeCliToolSupport {
            supported: false,
            detail: error.to_string(),
        },
    }
}

pub async fn ensure_native_cli_tool(tool: NativeCliToolId) -> Result<ResolvedNativeCliTool, NativeCliToolError> {
    ensure_native_cli_tool_with_reporter(tool, None).await
}

pub async fn ensure_native_cli_tool_with_reporter(
    tool: NativeCliToolId,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<ResolvedNativeCliTool, NativeCliToolError> {
    let spec = platform_spec().inspect_err(|error| {
        emit_progress(
            reporter,
            NativeCliProgress::failed(NativeCliFailureKind::UnsupportedPlatform, error.to_string()),
        );
    })?;
    let root = tool_root(tool, spec)?;

    // Prefer system-installed CLI on $PATH over managed downloads.
    // Most users already have these tools installed; downloading is a fallback.
    // Skip this in bundled mode: packaged/offline deployments must resolve the
    // tool from the bundled managed resources, not an arbitrary system binary.
    let bin_name = tool.binary_name();
    if !managed_resources::requires_bundled_resources()
        && let Some(system_path) = crate::resolve_command_path(bin_name)
    {
        info!(
            tool = tool.slug(),
            path = %system_path.display(),
            "native CLI found on system PATH; skipping managed download"
        );
        emit_progress(
            reporter,
            NativeCliProgress::ready(format!(
                "native CLI {} found at {}",
                tool.display_name(),
                system_path.display()
            )),
        );
        return Ok(ResolvedNativeCliTool {
            id: tool,
            version: "system".to_owned(),
            root: system_path.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
            binary_path: system_path,
        });
    }

    if let Ok(installed) = validate_tool_root(tool, &root, reporter) {
        return Ok(installed);
    }

    let lock = INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    if let Ok(installed) = validate_tool_root(tool, &root, reporter) {
        return Ok(installed);
    }

    if let Some(installed) =
        activate_local_tool_source(tool, spec, &root, reporter).map_err(|error| report_failure(error, reporter))?
    {
        return Ok(installed);
    }

    if managed_resources::requires_bundled_resources() {
        return Err(report_failure(
            NativeCliToolError::invalid(format!(
                "bundled native CLI {} artifact missing under the managed resources root",
                tool.display_name()
            )),
            reporter,
        ));
    }

    // No suitable CLI found on PATH or in bundled resources. The download
    // fallback (install_archive_with_retry) pointed at a poundingcore release
    // that has never existed. Instead of a misleading 404, give a clear error
    // telling the user how to install the CLI from the official source.
    Err(report_failure(
        NativeCliToolError::invalid(format!(
            "{} CLI is not installed. Install it via the official source: {}",
            tool.display_name(),
            tool.install_instruction()
        )),
        reporter,
    ))
}

fn validate_tool_root(
    tool: NativeCliToolId,
    root: &Path,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<ResolvedNativeCliTool, NativeCliToolError> {
    emit_progress(
        reporter,
        NativeCliProgress::validating(format!(
            "validating native CLI {} under {}",
            tool.display_name(),
            root.display()
        )),
    );
    let entrypoint = entrypoint_path(tool, root);
    if !entrypoint.is_file() {
        return Err(NativeCliToolError::invalid(format!(
            "native CLI entrypoint missing: {}",
            entrypoint.display()
        )));
    }
    Ok(ResolvedNativeCliTool {
        id: tool,
        version: tool.version().to_owned(),
        root: root.to_path_buf(),
        binary_path: entrypoint,
    })
}

fn entrypoint_path(tool: NativeCliToolId, root: &Path) -> PathBuf {
    let binary = tool.binary_name();
    match tool.runtime_kind() {
        types::NativeCliRuntimeKind::Node => root.join(binary).join(format!("{binary}.mjs")),
        types::NativeCliRuntimeKind::Native => {
            if cfg!(windows) {
                root.join(format!("{binary}.exe"))
            } else {
                let dot_bin = root.join(".bin").join(binary);
                if dot_bin.exists() { dot_bin } else { root.join(binary) }
            }
        }
        types::NativeCliRuntimeKind::Python => root.join(binary),
    }
}

fn activate_local_tool_source(
    tool: NativeCliToolId,
    spec: PlatformSpec,
    root: &Path,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<Option<ResolvedNativeCliTool>, NativeCliToolError> {
    let bundled_root = match managed_resources::bundled_root_candidate() {
        Some(r) if r.is_dir() => r,
        _ => return Ok(None),
    };
    let bundled_tool_root = bundled_root
        .join("cli")
        .join(tool.slug())
        .join(tool.version())
        .join(spec.manifest_key);
    if !bundled_tool_root.is_dir() {
        if managed_resources::requires_bundled_resources() {
            return Err(NativeCliToolError::invalid(format!(
                "bundled native CLI {} artifact missing under {}",
                tool.display_name(),
                bundled_tool_root.display()
            )));
        }
        return Ok(None);
    }

    emit_progress(
        reporter,
        NativeCliProgress::extracting(format!(
            "activating native CLI {} from bundled resources",
            tool.display_name()
        )),
    );

    if let Err(error) = managed_resources::materialize_directory(&bundled_tool_root, root) {
        if managed_resources::requires_bundled_resources() {
            return Err(NativeCliToolError::invalid(format!(
                "bundled native CLI {} artifact is invalid under {}: {}",
                tool.display_name(),
                bundled_tool_root.display(),
                error
            )));
        }
        warn!(
            tool = tool.slug(),
            source_root = %bundled_tool_root.display(),
            target_root = %root.display(),
            error = %error,
            "failed to activate bundled native CLI"
        );
        return Ok(None);
    }

    match validate_tool_root(tool, root, reporter) {
        Ok(resolved) => {
            info!(
                tool = tool.slug(),
                version = tool.version(),
                source_root = %bundled_tool_root.display(),
                target_root = %root.display(),
                "native CLI activated from bundled resources"
            );
            Ok(Some(resolved))
        }
        Err(error) => {
            warn!(
                tool = tool.slug(),
                source_root = %bundled_tool_root.display(),
                target_root = %root.display(),
                error = %error,
                "bundled native CLI failed validation"
            );
            let _ = fs::remove_dir_all(root);
            if managed_resources::requires_bundled_resources() {
                Err(NativeCliToolError::invalid(format!(
                    "bundled native CLI {} artifact failed validation under {}: {}",
                    tool.display_name(),
                    bundled_tool_root.display(),
                    error
                )))
            } else {
                Ok(None)
            }
        }
    }
}

async fn install_archive(
    root: &Path,
    tool: NativeCliToolId,
    spec: PlatformSpec,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<(), NativeCliToolError> {
    let client = build_http_client()?;
    let download_source = NativeCliDownloadSource::official(tool, spec);
    let url = download_source.url.clone();
    let archive_path = archive_download_path(root, tool, spec);

    if root.exists() {
        let _ = fs::remove_dir_all(root);
    }
    fs::create_dir_all(root).map_err(NativeCliToolError::io)?;
    if archive_path.exists() {
        let _ = fs::remove_file(&archive_path);
    }

    emit_progress(
        reporter,
        NativeCliProgress::downloading(format!("downloading native CLI {} from {url}", tool.display_name())),
    );

    info!(
        tool = tool.slug(),
        version = tool.version(),
        platform = spec.manifest_key,
        url = %url,
        "native CLI download started"
    );

    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| reqwest_error("download archive", &url, &error))?;
    let response = response
        .error_for_status()
        .map_err(|error| reqwest_error("download archive", &url, &error))?;
    stream_archive_to_file(response, &archive_path, &url, reporter).await?;
    if let Some(expected_sha256) = download_source.sha256.as_deref() {
        emit_progress(
            reporter,
            NativeCliProgress::validating("verifying native CLI artifact checksum".to_owned()),
        );
        verify_archive_checksum(&archive_path, expected_sha256)?;
    }

    emit_progress(
        reporter,
        NativeCliProgress::extracting(format!(
            "extracting native CLI {} into {}",
            tool.display_name(),
            root.display()
        )),
    );
    match spec.archive_ext {
        "tar.gz" => extract_tar_gz(&archive_path, root)?,
        "zip" => extract_zip(&archive_path, root)?,
        ext => {
            return Err(NativeCliToolError::invalid(format!(
                "unsupported archive extension: {ext}"
            )));
        }
    }
    fs::remove_file(&archive_path).ok();

    Ok(())
}

fn build_http_client() -> Result<reqwest::Client, NativeCliToolError> {
    http_client::build_http_client(NATIVE_CLI_CONNECT_TIMEOUT, NATIVE_CLI_DOWNLOAD_TIMEOUT)
        .map_err(NativeCliToolError::invalid)
}

fn verify_archive_checksum(path: &Path, expected_sha256: &str) -> Result<(), NativeCliToolError> {
    let bytes = fs::read(path).map_err(NativeCliToolError::io)?;
    let actual = hex::encode(Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(NativeCliToolError::invalid(format!(
            "native CLI archive checksum mismatch for {}: expected {expected_sha256}, got {actual}",
            path.display()
        )));
    }
    Ok(())
}

async fn install_archive_with_retry(
    root: &Path,
    tool: NativeCliToolId,
    spec: PlatformSpec,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<(), NativeCliToolError> {
    let mut last_error = None;
    for attempt in 1..=NATIVE_CLI_DOWNLOAD_ATTEMPTS {
        match install_archive(root, tool, spec, reporter).await {
            Ok(()) => return Ok(()),
            Err(error) if attempt < NATIVE_CLI_DOWNLOAD_ATTEMPTS => {
                warn!(
                    attempt,
                    max_attempts = NATIVE_CLI_DOWNLOAD_ATTEMPTS,
                    error = %error,
                    root = %root.display(),
                    "native CLI install attempt failed; retrying"
                );
                last_error = Some(error);
            }
            Err(error) => return Err(report_failure(error, reporter)),
        }
    }

    Err(last_error
        .map(|error| report_failure(error, reporter))
        .unwrap_or_else(|| NativeCliToolError::invalid("native CLI install failed")))
}

fn archive_download_path(root: &Path, tool: NativeCliToolId, spec: PlatformSpec) -> PathBuf {
    root.join(format!("{}-{}.download", tool.slug(), spec.manifest_key))
}

async fn stream_archive_to_file(
    mut response: reqwest::Response,
    archive_path: &Path,
    url: &str,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> Result<(), NativeCliToolError> {
    let mut writer = fs::File::create(archive_path).map_err(NativeCliToolError::io)?;
    let total_bytes = response.content_length();
    let mut downloaded_bytes = 0_u64;
    let mut next_report_threshold = NATIVE_CLI_PROGRESS_STEP_BYTES;

    loop {
        let chunk = tokio::time::timeout(NATIVE_CLI_DOWNLOAD_IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| timeout_error("read archive body", url, NATIVE_CLI_DOWNLOAD_IDLE_TIMEOUT))?
            .map_err(|error| reqwest_error("read archive body", url, &error))?;
        let Some(chunk) = chunk else {
            break;
        };

        writer.write_all(&chunk).map_err(NativeCliToolError::io)?;
        downloaded_bytes += chunk.len() as u64;

        if downloaded_bytes == chunk.len() as u64 || downloaded_bytes >= next_report_threshold {
            emit_progress(
                reporter,
                NativeCliProgress::downloading(download_progress_message(url, downloaded_bytes, total_bytes)),
            );
            while downloaded_bytes >= next_report_threshold {
                next_report_threshold += NATIVE_CLI_PROGRESS_STEP_BYTES;
            }
        }
    }

    writer.flush().map_err(NativeCliToolError::io)?;
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, root: &Path) -> Result<(), NativeCliToolError> {
    let archive_file = fs::File::open(archive_path).map_err(NativeCliToolError::io)?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(root)
        .map_err(|error| NativeCliToolError::invalid(format!("extract tar.gz failed: {error}")))
}

fn extract_zip(archive_path: &Path, root: &Path) -> Result<(), NativeCliToolError> {
    let archive_file = fs::File::open(archive_path).map_err(NativeCliToolError::io)?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| NativeCliToolError::invalid(format!("open zip failed: {error}")))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| NativeCliToolError::invalid(format!("read zip entry failed: {error}")))?;
        let Some(relative_path) = file.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let output_path = root.join(relative_path);
        if file.is_dir() {
            fs::create_dir_all(&output_path).map_err(NativeCliToolError::io)?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(NativeCliToolError::io)?;
        }

        let mut writer = fs::File::create(&output_path).map_err(NativeCliToolError::io)?;
        std::io::copy(&mut file, &mut writer).map_err(NativeCliToolError::io)?;
        writer.flush().map_err(NativeCliToolError::io)?;

        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = writer.metadata().map_err(NativeCliToolError::io)?.permissions();
            perms.set_mode(mode);
            fs::set_permissions(&output_path, perms).map_err(NativeCliToolError::io)?;
        }
    }

    Ok(())
}

fn platform_spec() -> Result<PlatformSpec, NativeCliToolError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(PlatformSpec {
            manifest_key: "darwin-arm64",
            archive_ext: "tar.gz",
        }),
        ("macos", "x86_64") => Ok(PlatformSpec {
            manifest_key: "darwin-x64",
            archive_ext: "tar.gz",
        }),
        ("linux", "aarch64") => Ok(PlatformSpec {
            manifest_key: "linux-arm64",
            archive_ext: "tar.gz",
        }),
        ("linux", "x86_64") => Ok(PlatformSpec {
            manifest_key: "linux-x64",
            archive_ext: "tar.gz",
        }),
        ("windows", "x86_64") => Ok(PlatformSpec {
            manifest_key: "win32-x64",
            archive_ext: "zip",
        }),
        ("windows", "aarch64") => Ok(PlatformSpec {
            manifest_key: "win32-arm64",
            archive_ext: "zip",
        }),
        (os, arch) => Err(NativeCliToolError::unsupported_platform(format!(
            "native CLI unsupported on {os}/{arch}"
        ))),
    }
}

fn tool_root(tool: NativeCliToolId, spec: PlatformSpec) -> Result<PathBuf, NativeCliToolError> {
    cache::native_cli_tool_root()
        .map(|root| root.join(tool.slug()).join(tool.version()).join(spec.manifest_key))
        .ok_or_else(|| NativeCliToolError::invalid("native CLI runtime cache dir unavailable"))
}

fn emit_progress(reporter: Option<&dyn NativeCliProgressReporter>, update: NativeCliProgress) {
    if let Some(reporter) = reporter {
        reporter.report(update);
    }
}

fn report_failure(error: NativeCliToolError, reporter: Option<&dyn NativeCliProgressReporter>) -> NativeCliToolError {
    let (kind, status_code) = classify_error(&error);
    emit_progress(
        reporter,
        match status_code {
            Some(status) => NativeCliProgress::failed_with_status(kind, status, error.to_string()),
            None => NativeCliProgress::failed(kind, error.to_string()),
        },
    );
    error
}

fn classify_error(error: &NativeCliToolError) -> (NativeCliFailureKind, Option<u16>) {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("timed out") {
        return (NativeCliFailureKind::Timeout, None);
    }
    if let Some(status) = parse_http_status(&message) {
        return (NativeCliFailureKind::HttpStatus, Some(status));
    }
    if message.contains("unsupported") {
        return (NativeCliFailureKind::UnsupportedPlatform, None);
    }
    if message.contains("bundled native cli") && message.contains("artifact missing") {
        return (NativeCliFailureKind::BundledResourceMissing, None);
    }
    if message.contains("bundled native cli") && message.contains("artifact is invalid") {
        return (NativeCliFailureKind::BundledResourceInvalid, None);
    }
    if message.contains("bundled native cli") && message.contains("failed validation") {
        return (NativeCliFailureKind::BundledResourceInvalid, None);
    }
    if message.contains("checksum mismatch") {
        return (NativeCliFailureKind::ChecksumMismatch, None);
    }
    if message.contains("validate") || message.contains("entrypoint missing") || message.contains("binary missing") {
        return (NativeCliFailureKind::ValidationFailed, None);
    }
    if message.contains("download") || message.contains("extract") || message.contains("connect failed") {
        return (NativeCliFailureKind::DownloadFailed, None);
    }
    (NativeCliFailureKind::Unknown, None)
}

fn parse_http_status(message: &str) -> Option<u16> {
    let marker = "http ";
    let start = message.find(marker)? + marker.len();
    let digits: String = message[start..].chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

fn reqwest_error(stage: &str, url: &str, error: &reqwest::Error) -> NativeCliToolError {
    if error.is_timeout() {
        return timeout_error(stage, url, NATIVE_CLI_DOWNLOAD_TIMEOUT);
    }
    if let Some(status) = error.status() {
        return http_status_error(stage, url, status);
    }
    if error.is_connect() {
        return NativeCliToolError::invalid(format!("{stage} connect failed for {url}: {error}"));
    }
    NativeCliToolError::invalid(format!("{stage} failed for {url}: {error}"))
}

fn timeout_error(stage: &str, url: &str, timeout: Duration) -> NativeCliToolError {
    NativeCliToolError::invalid(format!("{stage} timed out after {}s for {url}", timeout.as_secs()))
}

fn download_progress_message(url: &str, downloaded_bytes: u64, total_bytes: Option<u64>) -> String {
    let downloaded_mb = downloaded_bytes / (1024 * 1024);
    match total_bytes {
        Some(total) if total > 0 => {
            let total_mb = total / (1024 * 1024);
            format!("downloading native CLI from {url} ({downloaded_mb}MB / {total_mb}MB)")
        }
        _ => format!("downloading native CLI from {url} ({downloaded_mb}MB)"),
    }
}

fn http_status_error(stage: &str, url: &str, status: reqwest::StatusCode) -> NativeCliToolError {
    NativeCliToolError::invalid(format!("{stage} returned HTTP {} for {url}", status.as_u16()))
}

fn combined_retry_error(
    first_error: NativeCliToolError,
    retry_error: NativeCliToolError,
    reporter: Option<&dyn NativeCliProgressReporter>,
) -> NativeCliToolError {
    let combined = NativeCliToolError::invalid(format!("{first_error}; retry failed: {retry_error}"));
    let (kind, status_code) = classify_error(&retry_error);
    emit_progress(
        reporter,
        match status_code {
            Some(status) => NativeCliProgress::failed_with_status(kind, status, combined.to_string()),
            None => NativeCliProgress::failed(kind, combined.to_string()),
        },
    );
    combined
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_spec_macos_arm64_uses_tar_gz() {
        if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
            return;
        }
        let spec = platform_spec().expect("macos/arm64 should be supported");
        assert_eq!(spec.manifest_key, "darwin-arm64");
        assert_eq!(spec.archive_ext, "tar.gz");
    }

    #[test]
    fn native_cli_download_url_has_correct_format() {
        let spec = PlatformSpec {
            manifest_key: "darwin-arm64",
            archive_ext: "tar.gz",
        };
        let url = spec.download_url(NativeCliToolId::Hermes);
        assert!(url.contains("hermes"));
        assert!(url.contains("darwin-arm64"));
        assert!(url.contains("tar.gz"));
        assert!(url.contains("halojerry/poundingcore"));
    }

    #[test]
    fn entrypoint_path_resolves_by_runtime_kind() {
        let root = Path::new("/tmp/tool");
        if cfg!(windows) {
            assert_eq!(entrypoint_path(NativeCliToolId::Hermes, root), root.join("hermes"));
            assert_eq!(
                entrypoint_path(NativeCliToolId::OpenCode, root),
                root.join("opencode.exe")
            );
        } else {
            assert_eq!(entrypoint_path(NativeCliToolId::Hermes, root), root.join("hermes"));
            assert_eq!(entrypoint_path(NativeCliToolId::OpenCode, root), root.join("opencode"));
            assert_eq!(
                entrypoint_path(NativeCliToolId::OpenClaw, root),
                root.join("openclaw").join("openclaw.mjs")
            );
        }
    }

    #[test]
    fn validate_tool_root_rejects_missing_entrypoint() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let error =
            validate_tool_root(NativeCliToolId::Hermes, root, None).expect_err("missing entrypoint should fail");
        assert!(error.to_string().contains("entrypoint missing"));
    }

    #[tokio::test]
    async fn bundled_resource_missing_reports_bundled_resource_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled_root = tmp.path().join("bundled");
        if !crate::test_support::run_in_env_child(
            "native_cli_runtime::tests::bundled_resource_missing_reports_bundled_resource_missing",
            |command| {
                command.env("POUNDING_BUNDLED_MANAGED_RESOURCES", &bundled_root);
            },
        ) {
            return;
        }

        crate::cache::init(tmp.path().join("data"));
        managed_resources::set_managed_resources_mode(managed_resources::ManagedResourcesMode::Bundled);

        let result = ensure_native_cli_tool(NativeCliToolId::Hermes).await;
        managed_resources::set_managed_resources_mode(managed_resources::ManagedResourcesMode::Download);

        let error = result.expect_err("missing bundled native CLI should fail");
        assert!(error.to_string().contains("bundled native CLI"));
        assert!(error.to_string().contains("artifact missing"));
    }

    #[test]
    fn classify_error_detects_checksum_mismatch() {
        let error = NativeCliToolError::invalid("native CLI archive checksum mismatch");
        let (kind, status_code) = classify_error(&error);
        assert_eq!(kind, NativeCliFailureKind::ChecksumMismatch);
        assert_eq!(status_code, None);
    }
}
