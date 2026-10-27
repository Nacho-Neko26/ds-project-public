# 停止全部：桥接进程 + QQ/NapCat
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$bridges = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*qq-agent*src\index.mjs*' }
foreach ($p in $bridges) {
  Write-Host "结束桥接进程 PID $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force
}
if (-not $bridges) { Write-Host '没有找到运行中的桥接进程' }

$kill = Join-Path $root 'napcat\app\KillQQ.bat'
if (Test-Path $kill) {
  Write-Host '结束 QQ / NapCat'
  & cmd.exe /c $kill | Out-Null
}
Write-Host '已停止'
