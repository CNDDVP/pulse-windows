fn main() {
    let dist_index = std::path::Path::new("../dist/index.html");
    if !dist_index.exists() {
        panic!(
            "前端构建产物缺失 (未找到 '../dist/index.html')。请先执行 'npm run build' 生成前端资源，再执行后端编译构建。"
        );
    }
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_TIME={}", chrono::Utc::now().to_rfc3339());
    tauri_build::build();
}
