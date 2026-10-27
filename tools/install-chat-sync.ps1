# 安装/更新计划任务 DSH-Chat-Sync（不需要管理员）
# 触发：开机（登录）后 2 分钟跑一次，之后每小时一次。有 #同步 标记就同步。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-chat-sync.ps1

$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $ws 'tools\chat-sync.py'
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
    <Description>把 QQ 桥在服务器上积累的记忆库/知识库和本机同步（#同步 由服务器打标记）</Description>
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
        <Interval>PT30M</Interval>
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
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$py</Command>
      <Arguments>"$script" --watch-once</Arguments>
      <WorkingDirectory>$ws</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$tmp = Join-Path $env:TEMP 'dsh-chat-sync.xml'
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)
$out = schtasks /Create /TN DSH-Chat-Sync /XML $tmp /F 2>&1
Write-Host ($out -join "`n")
$info = schtasks /Query /TN DSH-Chat-Sync /FO LIST 2>&1
Write-Host ($info -join "`n")
