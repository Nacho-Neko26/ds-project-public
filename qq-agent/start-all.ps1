# 启动全部
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Port($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $c.Close()
    return $true
  } catch { return $false }
}

if (-not (Test-Port 3001)) {
  Write-Host '启动 NapCat（新窗口）...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\start-napcat.cmd`"" -WorkingDirectory $root
  Write-Host '等待 OneBot WebSocket 就绪...' -ForegroundColor DarkGray
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Port 3001) { Write-Host 'OneBot 已就绪' -ForegroundColor Green; break }
  }
} else {
  Write-Host 'NapCat 已在运行（3001 已监听）' -ForegroundColor Green
}

if (-not (Test-Port 3899)) {
  Write-Host '启动桥接进程（新窗口）...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$root\start-bridge.cmd`"" -WorkingDirectory $root
  Start-Sleep -Seconds 3
} else {
  Write-Host '桥接进程已在运行（3899 已监听）' -ForegroundColor Green
}

Write-Host ''
Write-Host '控制台: http://127.0.0.1:3899' -ForegroundColor Yellow
