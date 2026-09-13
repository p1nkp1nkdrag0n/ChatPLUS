#requires -Version 5.1
<#
Local Sakura Frp control. Run with status, start, or stop. No elevation is needed.

Root/sakura.json contains { "tunnelId": "123456" }. Optional binarySha256 pins
a separately verified client update. The default pin is the verified sakura-14
Windows amd64 client. Only ONE tunnel ID is accepted; configure that tunnel in
Sakura to forward to Dearvale's user listener (127.0.0.1:3001).

Root/.secrets/sakura-token.dpapi is raw ProtectedData.Protect output using
CurrentUser, UTF-8 token bytes, and UTF-8 entropy DearvaleTunnel:SakuraToken:v1.
Provision it separately without placing a token in a command line or transcript.
The script never writes an frpc configuration or stores frpc output. Diagnostic
events are classified in memory and only fixed event names are written to logs.

Official environment/argument contract: https://doc.natfrp.com/frpc/manual
The private -Supervisor/-BootId switches are used by start, not by operators.
Stopping closes this tunnel's process only; it does not stop Dearvale itself.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'stop')]
    [string]$Action = 'status',
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'DearvaleTunnel'),
    [switch]$Supervisor,
    [string]$BootId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:FailureCode = 'operation_failed'
$script:Utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$script:CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:AllowedSids = @($script:CurrentSid, 'S-1-5-18', 'S-1-5-32-544')
$script:Events = @('starting', 'agent_started', 'node_authenticated', 'tunnel_online', 'authentication_error', 'connection_error', 'local_service_error', 'agent_warning', 'stop_requested', 'stopped', 'agent_exited', 'supervisor_failed')

function Fail([string]$Code) {
    $script:FailureCode = $Code
    throw [System.InvalidOperationException]::new($Code)
}

function Assert-RegularPath([string]$Path, [bool]$Directory = $false) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { Fail 'unsafe_file_type' }
    return $item
}

function Assert-PrivatePath([string]$Path, [bool]$Directory = $false) {
    $item = Assert-RegularPath $Path $Directory
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($script:AllowedSids -notcontains $sid) { Fail 'directory_permissions_too_broad' }
        }
    }
    return $item
}

function Read-SmallJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Assert-PrivatePath $Path
    if ($item.Length -gt 4096) { Fail 'control_file_too_large' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $buffer = [byte[]]::new(4097)
        $count = $stream.Read($buffer, 0, $buffer.Length)
        if ($count -gt 4096) { Fail 'control_file_too_large' }
        return $script:Utf8.GetString($buffer, 0, $count) | ConvertFrom-Json
    } finally { $stream.Dispose() }
}

function Write-PrivateJson([string]$Path, $Value) {
    if (Test-Path -LiteralPath $Path) { $null = Assert-PrivatePath $Path }
    $temporary = Join-Path $script:RootPath ('.sakura-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 4) + "`n")
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-OwnedProcess($Record, [string]$Prefix) {
    $idProperty = $Record.PSObject.Properties[$Prefix + 'Pid']
    $ticksProperty = $Record.PSObject.Properties[$Prefix + 'StartedTicks']
    $pathProperty = $Record.PSObject.Properties[$Prefix + 'Path']
    if (-not $idProperty -or -not $ticksProperty -or -not $pathProperty) { return $null }
    $processId = 0
    $ticks = 0L
    if (-not [int]::TryParse([string]$idProperty.Value, [ref]$processId) -or $processId -le 0 -or
        -not [long]::TryParse([string]$ticksProperty.Value, [ref]$ticks) -or $ticks -le 0) { Fail 'invalid_process_record' }
    try { $process = [Diagnostics.Process]::GetProcessById($processId) }
    catch [ArgumentException] { return $null }
    if ($process.HasExited) { $process.Dispose(); return $null }
    if ($process.StartTime.ToUniversalTime().Ticks -ne $ticks -or $process.MainModule.FileName -ine [string]$pathProperty.Value) {
        $process.Dispose()
        return $null
    }
    return $process
}

function Read-State {
    $state = Read-SmallJson $script:StatePath
    if ($null -eq $state) { return $null }
    if (-not $state.PSObject.Properties['bootId'] -or [string]$state.bootId -notmatch '^[a-f0-9]{32}$' -or
        -not $state.PSObject.Properties['event'] -or $script:Events -notcontains [string]$state.event) { Fail 'invalid_runtime_record' }
    return $state
}

function Get-Status {
    $state = Read-State
    if ($null -eq $state) { return [ordered]@{ status = 'stopped'; event = $null } }
    $owner = Get-OwnedProcess $state 'supervisor'
    $agent = Get-OwnedProcess $state 'agent'
    try {
        $status = 'stopped'
        if ($owner) { $status = 'running' }
        elseif ($agent) { $status = 'orphaned_agent' }
        return [ordered]@{
            status = $status; event = [string]$state.event; updatedAtUtc = [string]$state.updatedAtUtc
            supervisorPid = $(if ($owner) { $owner.Id } else { $null })
            agentPid = $(if ($agent) { $agent.Id } else { $null })
            tunnelId = [string]$state.tunnelId
        }
    } finally {
        if ($owner) { $owner.Dispose() }
        if ($agent) { $agent.Dispose() }
    }
}

function New-ChildInfo([string]$Executable, [string]$Arguments, [string]$WorkingDirectory) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    # Do not inherit unrelated API keys, access tokens, proxy credentials or PS profiles.
    $info.EnvironmentVariables.Clear()
    foreach ($name in @('OS', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $info.EnvironmentVariables[$name] = $value }
    }
    $info.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
    return $info
}

function Write-Event([string]$Event, [Nullable[int]]$ExitCode = $null) {
    if ($script:Events -notcontains $Event) { Fail 'invalid_event' }
    $script:Runtime.event = $Event
    $script:Runtime.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    if ($null -ne $ExitCode) { $script:Runtime.exitCode = $ExitCode }
    Write-PrivateJson $script:StatePath $script:Runtime
    $entry = [ordered]@{ atUtc = $script:Runtime.updatedAtUtc; event = $Event; bootId = $BootId }
    if ($null -ne $ExitCode) { $entry.exitCode = $ExitCode }
    if (Test-Path -LiteralPath $script:LogPath) {
        $log = Assert-PrivatePath $script:LogPath
        if ($log.Length -ge 1048576) {
            $old = $script:LogPath + '.1'
            if (Test-Path -LiteralPath $old) { $null = Assert-PrivatePath $old; [IO.File]::Delete($old) }
            [IO.File]::Move($script:LogPath, $old)
        }
    }
    [IO.File]::AppendAllText($script:LogPath, (($entry | ConvertTo-Json -Compress) + "`n"), $script:Utf8)
}

function Read-AgentOutput($Reader) {
    if ($null -eq $Reader.task -or -not $Reader.task.IsCompleted) { return }
    $count = $Reader.task.GetAwaiter().GetResult()
    if ($count -eq 0) { $Reader.task = $null; return }
    # Bounded memory; no raw provider/client line, path, exception or token is logged.
    $chunk = $Reader.tail + [string]::new($Reader.buffer, 0, $count)
    $event = $null
    if ($chunk -match '(?i)token.{0,24}(invalid|incorrect|expired)|authentication failed|authorization failed|access denied|unauthorized') { $event = 'authentication_error' }
    elseif ($chunk -match '(?i)connect to local service|connect to local server|local.{0,30}connection refused') { $event = 'local_service_error' }
    elseif ($chunk -match '(?i)start proxy success|proxy.{0,32}started successfully') { $event = 'tunnel_online' }
    elseif ($chunk -match '(?i)login to server success') { $event = 'node_authenticated' }
    elseif ($chunk -match '(?i)login to server failed|connection refused|connection reset|i/o timeout|network is unreachable|reconnect') { $event = 'connection_error' }
    elseif ($chunk -match '(?i)\[(E|W)\]|\b(error|fatal|panic|warning)\b') { $event = 'agent_warning' }
    if ($event -and $script:Runtime.event -ne $event) { Write-Event $event }
    $Reader.tail = $chunk.Substring([Math]::Max(0, $chunk.Length - 256))
    $Reader.task = $Reader.stream.ReadAsync($Reader.buffer, 0, $Reader.buffer.Length)
}

function Run-Supervisor {
    if ($BootId -notmatch '^[a-f0-9]{32}$') { Fail 'invalid_boot_id' }
    $lock = $null
    $agent = $null
    $job = $null
    $tokenBytes = $null
    $token = $null
    try {
        $lockPath = Join-Path $script:RootPath 'sakura.lock'
        if (Test-Path -LiteralPath $lockPath) { $null = Assert-PrivatePath $lockPath }
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { Fail 'already_running' }
        $prior = Get-Status
        if ($prior.status -ne 'stopped') { Fail 'already_running' }
        $settings = Read-SmallJson (Join-Path $script:RootPath 'sakura.json')
        if (-not $settings -or -not $settings.PSObject.Properties['tunnelId'] -or [string]$settings.tunnelId -notmatch '^[1-9][0-9]{0,11}$') { Fail 'invalid_tunnel_id' }
        $binary = Join-Path $script:RootPath 'bin\frpc_windows_amd64.exe'
        $null = Assert-PrivatePath (Join-Path $script:RootPath 'bin') $true
        $null = Assert-PrivatePath $binary
        $expected = 'b705262edad9f0de04b38f342e811e9d97d0beada75edab3f790e105dcfb5234'
        if ($settings.PSObject.Properties['binarySha256']) { $expected = [string]$settings.binarySha256 }
        if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ine $expected) { Fail 'binary_hash_mismatch' }
        $secretDirectory = Join-Path $script:RootPath '.secrets'
        $null = Assert-PrivatePath $secretDirectory $true
        $secretFile = Join-Path $secretDirectory 'sakura-token.dpapi'
        $secretInfo = Assert-PrivatePath $secretFile
        if ($secretInfo.Length -lt 1 -or $secretInfo.Length -gt 8192) { Fail 'invalid_credential_file' }
        Add-Type -AssemblyName System.Security
        try {
            $tokenBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($secretFile), $script:Utf8.GetBytes('DearvaleTunnel:SakuraToken:v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
            $token = $script:Utf8.GetString($tokenBytes)
        } catch { Fail 'credential_decryption_failed' }
        if ($token -notmatch '^[!-~]{8,512}$') { Fail 'invalid_credential' }
        $working = Join-Path $script:RootPath 'work'
        $logs = Join-Path $script:RootPath 'logs'
        foreach ($directory in @($working, $logs)) {
            if (-not (Test-Path -LiteralPath $directory)) { $null = [IO.Directory]::CreateDirectory($directory) }
            $null = Assert-PrivatePath $directory $true
        }
        if (Test-Path -LiteralPath (Join-Path $working 'frpc.ini')) { Fail 'plaintext_config_not_allowed' }
        $script:LogPath = Join-Path $logs 'sakura-events.jsonl'
        $self = [Diagnostics.Process]::GetCurrentProcess()
        $script:Runtime = [ordered]@{
            bootId = $BootId; tunnelId = [string]$settings.tunnelId
            supervisorPid = $self.Id; supervisorStartedTicks = [string]$self.StartTime.ToUniversalTime().Ticks; supervisorPath = $self.MainModule.FileName
            event = 'starting'; updatedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-Event 'starting'
        # The job owns only this child. Closing/crashing the supervisor also closes
        # its tunnel, rather than leaving an untracked frpc process behind.
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class DearvaleSakuraJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Counters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr handle;
    public DearvaleSakuraJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var limits = new Limits(); limits.Basic.Flags = 0x2000;
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits)))) { CloseHandle(handle); handle = IntPtr.Zero; throw new Win32Exception(); }
    }
    public void Assign(IntPtr process) { if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
'@
        $job = [DearvaleSakuraJob]::new()
        $info = New-ChildInfo $binary '--disable_log_color' $working
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.RedirectStandardInput = $true
        $info.EnvironmentVariables['NATFRP_TOKEN'] = $token
        $info.EnvironmentVariables['NATFRP_TARGET'] = [string]$settings.tunnelId
        $agent = [Diagnostics.Process]::new()
        $agent.StartInfo = $info
        $null = $agent.Start()
        $job.Assign($agent.Handle)
        $agent.StandardInput.Close()
        $info.EnvironmentVariables.Remove('NATFRP_TOKEN')
        [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
        $tokenBytes = $null
        $token = $null
        $script:Runtime.agentPid = $agent.Id
        $script:Runtime.agentStartedTicks = [string]$agent.StartTime.ToUniversalTime().Ticks
        $script:Runtime.agentPath = $binary
        Write-Event 'agent_started'
        $readers = @($agent.StandardOutput, $agent.StandardError) | ForEach-Object {
            $buffer = [char[]]::new(4096)
            @{ stream = $_; buffer = $buffer; tail = ''; task = $_.ReadAsync($buffer, 0, $buffer.Length) }
        }
        $requestedStop = $false
        while (-not $agent.HasExited) {
            foreach ($reader in $readers) { Read-AgentOutput $reader }
            try { $request = Read-SmallJson $script:StopPath } catch { $request = $null }
            if ($request -and $request.PSObject.Properties['bootId'] -and [string]$request.bootId -ceq $BootId) {
                Write-Event 'stop_requested'
                $requestedStop = $true
                $job.Dispose()
                if (-not $agent.WaitForExit(10000)) { Fail 'agent_stop_timeout' }
                break
            }
            Start-Sleep -Milliseconds 200
        }
        $agent.WaitForExit()
        if ($requestedStop) { Write-Event 'stopped' $agent.ExitCode }
        else { Write-Event 'agent_exited' $agent.ExitCode }
    } catch {
        if (Get-Variable -Name Runtime -Scope Script -ErrorAction SilentlyContinue) {
            try { Write-Event 'supervisor_failed' } catch { }
        }
        throw
    } finally {
        if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
        $token = $null
        if ($job) { $job.Dispose() }
        if ($agent) { if (-not $agent.HasExited) { $agent.Kill(); $null = $agent.WaitForExit(10000) }; $agent.Dispose() }
        try {
            $request = Read-SmallJson $script:StopPath
            if ($request -and $request.PSObject.Properties['bootId'] -and [string]$request.bootId -ceq $BootId) { [IO.File]::Delete($script:StopPath) }
        } catch { }
        if ($lock) { $lock.Dispose() }
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { Fail 'windows_required' }
    # A pwsh parent can pass a PSModulePath that breaks Windows PowerShell 5.1
    # module auto-loading. Resolve the current host's built-in modules directly.
    foreach ($module in @('Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Utility')) {
        Import-Module -Name (Join-Path $PSHOME ('Modules\' + $module + '\' + $module + '.psd1')) -ErrorAction Stop
    }
    $script:RootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($script:RootPath -match '["\r\n]') { Fail 'invalid_root_path' }
    $null = Assert-PrivatePath $script:RootPath $true
    $script:StatePath = Join-Path $script:RootPath 'sakura-runtime.json'
    $script:StopPath = Join-Path $script:RootPath 'sakura-stop.json'
    if ($Supervisor) {
        if ($Action -ne 'start') { Fail 'invalid_supervisor_action' }
        Run-Supervisor
        exit 0
    }
    if ($Action -eq 'status') { Get-Status | ConvertTo-Json -Compress; exit 0 }
    $state = Read-State
    $status = Get-Status
    if ($Action -eq 'stop') {
        if ($status.status -eq 'stopped') { $status | ConvertTo-Json -Compress; exit 0 }
        if ($status.status -eq 'orphaned_agent') { Fail 'orphaned_agent_requires_review' }
        Write-PrivateJson $script:StopPath @{ bootId = [string]$state.bootId }
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 200
            $fresh = Read-State
            if ($fresh -and [string]$fresh.bootId -cne [string]$state.bootId) { Fail 'instance_changed' }
            $status = Get-Status
            if ($status.status -eq 'stopped') { $status | ConvertTo-Json -Compress; exit 0 }
        } while ([DateTime]::UtcNow -lt $deadline)
        Fail 'stop_timeout_no_unrelated_process_was_killed'
    }
    if ($status.status -ne 'stopped') { Fail 'already_running' }
    $newBootId = [guid]::NewGuid().ToString('N')
    $shellPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" start -Supervisor -Root "' + $script:RootPath + '" -BootId ' + $newBootId
    # ShellExecute starts a separate hidden console. Redirected .NET Framework
    # grandchildren otherwise inherit the caller's pipe handles and can keep a
    # terminal/automation waiting after the start command has already exited.
    # This supervisor receives no credential arguments and decrypts DPAPI itself;
    # New-ChildInfo still supplies only an allowlisted environment to frpc.
    $launcher = Start-Process -FilePath $shellPath -ArgumentList $arguments -WorkingDirectory $script:RootPath -WindowStyle Hidden -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 200
            $fresh = Read-State
            if ($fresh -and [string]$fresh.bootId -ceq $newBootId -and $fresh.PSObject.Properties['agentPid']) {
                $status = Get-Status
                if ($status.status -eq 'running' -and $status.agentPid) { $status | ConvertTo-Json -Compress; exit 0 }
            }
            if ($launcher.HasExited) { Fail 'start_failed_check_credentials_config_and_acl' }
        } while ([DateTime]::UtcNow -lt $deadline)
        Fail 'start_timeout_check_status_before_retrying'
    } finally { $launcher.Dispose() }
} catch {
    # Never interpolate exceptions: client/DPAPI/filesystem errors can contain data.
    if ($script:FailureCode -eq 'operation_failed') { $script:FailureCode = 'operation_failed_line_' + $_.InvocationInfo.ScriptLineNumber }
    [Console]::Error.WriteLine('Sakura helper: ' + $script:FailureCode)
    exit 1
}
