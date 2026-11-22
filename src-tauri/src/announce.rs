//! Announce file for Apphub (github.com/matthewjaybarr-png/apphub): on every start Crib writes
//! <platform config folder>/io.github.apphub/apps/<name>.json saying where it is installed and which
//! version runs, so Apphub lists it without being told. A failure is printed and never stops the app.
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn write(config_dir: Option<PathBuf>, name: &str, version: &str) {
    let (Some(cfg), Ok(exe)) = (config_dir, std::env::current_exe()) else { return };
    let folder = cfg.join("io.github.apphub").join("apps");
    if let Err(e) = write_in(&folder, name, version, &exe, SystemTime::now()) {
        eprintln!("announce: {e}");
    }
}

fn write_in(folder: &Path, name: &str, version: &str, exe: &Path, now: SystemTime) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)?;
    let body = serde_json::json!({
        "schema_version": 1,
        "app": name,
        "version": version,
        "exe": exe.to_string_lossy(),
        "seen_at": iso(now),
    });
    // write a temp file then rename, so Apphub never reads half a file
    let tmp = folder.join(format!(".{name}.json.tmp"));
    std::fs::write(&tmp, body.to_string())?;
    std::fs::rename(tmp, folder.join(format!("{name}.json")))
}

/// UTC time as 2026-11-22T09:30:00Z (days-to-date from Howard Hinnant's civil_from_days).
fn iso(t: SystemTime) -> String {
    let s = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (s.div_euclid(86400), s.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn writes_the_apphub_shape() {
        assert_eq!(iso(UNIX_EPOCH + Duration::from_secs(1_795_340_000)), "2026-11-22T09:33:20Z");
        let dir = std::env::temp_dir().join(format!("crib-announce-{}", std::process::id()));
        write_in(&dir, "Crib", "1.2.3", Path::new("/opt/crib/crib"), UNIX_EPOCH).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("Crib.json")).unwrap()).unwrap();
        assert_eq!(v["schema_version"], 1);
        assert_eq!(v["app"], "Crib");
        assert_eq!(v["seen_at"], "1970-01-01T00:00:00Z");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
