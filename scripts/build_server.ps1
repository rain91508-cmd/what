#!/usr/bin/env pwsh
<#
.SYNOPSIS
    HWDA Server 编译脚本
.DESCRIPTION
    清理、编译服务器，记录日志并分析编译结果
.PARAMETER Release
    是否编译 Release 版本（默认）
.PARAMETER Clean
    是否清理 target 目录
#>

param(
    [switch]$DebugBuild,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

# 颜色定义
$Red = "Red"
$Green = "Green"
$Yellow = "Yellow"
$Cyan = "Cyan"

# 路径配置
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ServerDir = Join-Path $ProjectRoot "server"
$TargetDir = Join-Path $ServerDir "target"
$ReleaseDir = Join-Path $TargetDir "release"
$LogDir = Join-Path $ProjectRoot "logs"
$LogFile = Join-Path $LogDir "build_server_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

# 可执行文件路径
$Executable = Join-Path $ReleaseDir "hwda-server.exe"

Write-Host "========================================" -ForegroundColor $Cyan
Write-Host "HWDA Server 编译脚本" -ForegroundColor $Cyan
Write-Host "========================================" -ForegroundColor $Cyan
Write-Host ""

# 创建日志目录
if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# 日志函数
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $logEntry
    
    switch ($Level) {
        "ERROR" { Write-Host $Message -ForegroundColor $Red }
        "WARN"  { Write-Host $Message -ForegroundColor $Yellow }
        "SUCCESS" { Write-Host $Message -ForegroundColor $Green }
        default { Write-Host $Message }
    }
}

Write-Log "开始编译过程..." "INFO"
Write-Log "项目根目录: $ProjectRoot" "INFO"
Write-Log "服务器目录: $ServerDir" "INFO"
Write-Log "日志文件: $LogFile" "INFO"
Write-Log ""

# 步骤 1: 清理旧的编译产物
Write-Log "步骤 1: 清理旧的编译产物..." "INFO"

try {
    # 删除可执行文件
    if (Test-Path $Executable) {
        Remove-Item $Executable -Force
        Write-Log "  已删除旧的可执行文件: $Executable" "INFO"
    }
    
    # 可选：清理整个 target 目录
    if ($Clean -and (Test-Path $TargetDir)) {
        Remove-Item $TargetDir -Recurse -Force
        Write-Log "  已清理整个 target 目录" "INFO"
    }
    
    Write-Log "  ✓ 清理完成" "SUCCESS"
} catch {
    Write-Log "  ✗ 清理失败: $_" "ERROR"
    exit 1
}

Write-Log ""

# 步骤 2: 执行编译
Write-Log "步骤 2: 开始编译..." "INFO"

$buildMode = if ($DebugBuild) { "debug" } else { "release" }
$buildArg = if ($DebugBuild) { "" } else { "--release" }

Write-Log "  编译模式: $buildMode" "INFO"
Write-Log "  编译参数: cargo build $buildArg" "INFO"
Write-Log ""

Push-Location $ServerDir
try {
    # 执行编译并捕获输出
    $compileOutput = cargo build $buildArg.Split() 2>&1
    $compileOutput | ForEach-Object { 
        Write-Log "  $_" "INFO"
    }
    
    # 检查编译结果
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -ne 0) {
        Write-Log ""
        Write-Log "✗ 编译失败 (退出码: $exitCode)" "ERROR"
        exit $exitCode
    }
    
    Write-Log ""
    Write-Log "✓ 编译成功完成" "SUCCESS"
} catch {
    Write-Log ""
    Write-Log "✗ 编译过程出错: $_" "ERROR"
    exit 1
} finally {
    Pop-Location
}

Write-Log ""

# 步骤 3: 验证可执行文件
Write-Log "步骤 3: 验证可执行文件..." "INFO"

if (Test-Path $Executable) {
    $fileInfo = Get-Item $Executable
    $fileSize = [math]::Round($fileInfo.Length / 1MB, 2)
    Write-Log "  ✓ 可执行文件已生成" "SUCCESS"
    Write-Log "    路径: $Executable" "INFO"
    Write-Log "    大小: $fileSize MB" "INFO"
    Write-Log "    修改时间: $($fileInfo.LastWriteTime)" "INFO"
} else {
    Write-Log "  ✗ 可执行文件未找到!" "ERROR"
    exit 1
}

Write-Log ""

# 步骤 4: 分析编译日志
Write-Log "步骤 4: 分析编译结果..." "INFO"

$logContent = Get-Content $LogFile -Raw

# 统计错误
$errorCount = ([regex]::Matches($logContent, "(?m)^error\[")).Count
$warningCount = ([regex]::Matches($logContent, "(?m)^warning:")).Count

Write-Log "  编译统计:" "INFO"
Write-Log "    - 错误数: $errorCount" $(if ($errorCount -gt 0) { "ERROR" } else { "SUCCESS" })
Write-Log "    - 警告数: $warningCount" $(if ($warningCount -gt 0) { "WARN" } else { "SUCCESS" })

# 提取错误详情
if ($errorCount -gt 0) {
    Write-Log ""
    Write-Log "错误详情:" "ERROR"
    $errors = $logContent -split "`n" | Select-String "^error\["
    $errors | ForEach-Object { Write-Log "  $_" "ERROR" }
}

# 提取警告详情（前10个）
if ($warningCount -gt 0) {
    Write-Log ""
    Write-Log "警告详情 (前10个):" "WARN"
    $warnings = $logContent -split "`n" | Select-String "^warning:" | Select-Object -First 10
    $warnings | ForEach-Object { Write-Log "  $_" "WARN" }
    
    if ($warningCount -gt 10) {
        Write-Log "  ... 还有 $($warningCount - 10) 个警告" "WARN"
    }
}

Write-Log ""

# 总结
Write-Log "========================================" "INFO"
if ($errorCount -eq 0) {
    Write-Log "编译成功!" "SUCCESS"
    Write-Log "可执行文件: $Executable" "SUCCESS"
    exit 0
} else {
    Write-Log "编译失败，请查看日志: $LogFile" "ERROR"
    exit 1
}
