# 安装/更新计划任务 DSH-QQ-Code-Sync（不需要管理员）
# 作用：每 10 分钟比对服务器 /root/qq-agent 下 src/*.mjs 与 config/config.json 的 md5，
#       服务器更新就自动拉回本机母本；本机正在编辑的文件不会被覆盖。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-code-sync.ps1

$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $ws 'tools\sync-from-server.py'
if (-not (Test-Path $script)) { throw "找不到 $script" }

$py = 'C:\Users\14381\AppData\Local\Programs\Python\Python312\pythonw.exe'
if (-not (Test-Path $py)) { $py = 'C:\Users\14381\AppData\Local\Programs\Python\Python312\python.exe' }
if (-not (Test-Path $py)) { $py = (Get-Command python).Source }
$user = "$env:USERDOMAIN\$env:USERNAME"
$start = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>把服务器上改过的 qq-agent 代码（src/*.mjs、config/config.json）自动拉回本机母本；本机在编辑的文件跳过不覆盖</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$py</Command>
      <Arguments>"$script"</Arguments>
      <WorkingDirectory>$ws</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP 'dsh-code-sync-task.xml'
Set-Content -Path $tmp -Value $xml -Encoding Unicode
schtasks /Create /TN "DSH-QQ-Code-Sync" /XML $tmp /F | Out-Host
Remove-Item $tmp -ErrorAction SilentlyContinue
Write-Host "完成。手动催一次：schtasks /Run /TN DSH-QQ-Code-Sync"
