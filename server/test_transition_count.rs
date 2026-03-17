// 简单的 transition 数量对比测试
use std::process::Command;

fn main() {
    println!("运行 transition 数量对比测试...");
    
    // 运行 server 的 compare test
    let output = Command::new("./target/release/hwda-server.exe")
        .args(&["--compare-test"])
        .current_dir(".")
        .output()
        .expect("Failed to run server");
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    println!("stdout:\n{}", stdout);
    println!("stderr:\n{}", stderr);
}
