// Simple transition-count comparison test
use std::process::Command;

fn main() {
    println!("Running transition-count comparison test...");

    // Run the server's compare test
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
