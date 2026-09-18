fn main() {
    let dist_index = std::path::Path::new("../dist/index.html");
    if !dist_index.exists() {
        panic!(
            "前端构建产物缺失 (未找到 '../dist/index.html')。请先执行 'npm run build' 生成前端资源，再执行后端编译构建。"
        );
    }
    tauri_build::build();
}
