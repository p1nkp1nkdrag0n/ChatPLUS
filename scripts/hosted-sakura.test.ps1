#requires -Version 5.1
# Local integration test. Compiles a fake process with no network code, creates
# fake DPAPI credentials under a fresh temporary directory, and never uses the
# real DearvaleTunnel directory or the real frpc executable.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'hosted-sakura.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dearvale-sakura-test-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$fakeToken = 'local-test-token-123456789'

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-Helper([string]$Action) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $shell
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $helper + '" ' + $Action + ' -Root "' + $testRoot + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Remove('PSModulePath')
    $info.EnvironmentVariables['DEARVALE_TEST_POISON'] = 'must-not-reach-frpc'
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(45000)) { $process.Kill(); throw 'Temporary helper did not complete.' }
        return @{ code = $process.ExitCode; stdout = $stdout.Result; stderr = $stderr.Result }
    } finally { $process.Dispose() }
}

try {
    $null = [IO.Directory]::CreateDirectory($testRoot)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $testRoot -AclObject $acl
    $null = [IO.Directory]::CreateDirectory((Join-Path $testRoot 'bin'))
    $null = [IO.Directory]::CreateDirectory((Join-Path $testRoot '.secrets'))
    $fakePath = Join-Path $testRoot 'bin\frpc_windows_amd64.exe'
    Add-Type -OutputAssembly $fakePath -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class FakeFrpc {
    public static void Main(string[] args) {
        bool correct = Environment.GetEnvironmentVariable("NATFRP_TOKEN") == "local-test-token-123456789"
            && Environment.GetEnvironmentVariable("NATFRP_TARGET") == "123456"
            && Environment.GetEnvironmentVariable("DEARVALE_TEST_POISON") == null
            && args.Length == 1 && args[0] == "--disable_log_color";
        File.WriteAllText("fake-env-check.json", correct ? "true" : "false");
        Console.WriteLine("login to server success " + Environment.GetEnvironmentVariable("NATFRP_TOKEN"));
        Thread.Sleep(600);
        Console.Error.WriteLine("start proxy success " + Environment.GetEnvironmentVariable("NATFRP_TOKEN"));
        while (true) Thread.Sleep(250);
    }
}
'@
    $settings = @{ tunnelId = '123456'; localPort = 3001; publicOrigin = 'https://test.invalid'; binarySha256 = (Get-FileHash -LiteralPath $fakePath -Algorithm SHA256).Hash }
    [IO.File]::WriteAllText((Join-Path $testRoot 'sakura.json'), ($settings | ConvertTo-Json), $utf8)
    Add-Type -AssemblyName System.Security
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($fakeToken), $utf8.GetBytes('DearvaleTunnel:SakuraToken:v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes((Join-Path $testRoot '.secrets\sakura-token.dpapi'), $encrypted)

    $before = Invoke-Helper 'status'
    Assert ($before.code -eq 0 -and ($before.stdout | ConvertFrom-Json).status -eq 'stopped') 'Initial status was not stopped.'
    $start = Invoke-Helper 'start'
    Assert ($start.code -eq 0) ('Fake start failed: ' + $start.stderr)
    Start-Sleep -Milliseconds 1600
    $running = Invoke-Helper 'status'
    $state = $running.stdout | ConvertFrom-Json
    Assert ($running.code -eq 0 -and $state.status -eq 'running' -and $state.event -eq 'tunnel_online') 'Fake tunnel did not report sanitized online state.'
    Assert ([IO.File]::ReadAllText((Join-Path $testRoot 'work\fake-env-check.json')) -eq 'true') 'Credentials/target were not environment-only or unrelated environment leaked.'
    $duplicate = Invoke-Helper 'start'
    Assert ($duplicate.code -eq 1 -and $duplicate.stderr -match 'already_running') 'Duplicate start was not rejected.'
    # A stale nonce must not stop the current process.
    [IO.File]::WriteAllText((Join-Path $testRoot 'sakura-stop.json'), '{"bootId":"00000000000000000000000000000000"}', $utf8)
    Start-Sleep -Milliseconds 600
    $afterStale = Invoke-Helper 'status'
    Assert (($afterStale.stdout | ConvertFrom-Json).status -eq 'running') 'Stale stop request terminated the current process.'
    $stop = Invoke-Helper 'stop'
    Assert ($stop.code -eq 0 -and ($stop.stdout | ConvertFrom-Json).status -eq 'stopped') ('Stop failed: ' + $stop.stderr)
    Assert (-not (Get-Process -Id $state.agentPid -ErrorAction SilentlyContinue)) 'Owned fake agent survived stop.'
    $logs = [IO.File]::ReadAllText((Join-Path $testRoot 'logs\sakura-events.jsonl'))
    Assert (-not $logs.Contains($fakeToken) -and -not $logs.Contains('login to server success') -and -not $logs.Contains('start proxy success')) 'Raw agent output or token entered lifecycle logs.'
    Assert ($logs.Contains('tunnel_online') -and $logs.Contains('stopped')) 'Lifecycle diagnostics were missing.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $testRoot 'work\frpc.ini'))) 'A plaintext frpc config was written.'
    # Integrity mismatch must fail before a second child can run.
    $settings.binarySha256 = '0' * 64
    [IO.File]::WriteAllText((Join-Path $testRoot 'sakura.json'), ($settings | ConvertTo-Json), $utf8)
    $invalid = Invoke-Helper 'start'
    Assert ($invalid.code -eq 1) 'Invalid binary hash was accepted.'
    Write-Output 'PASS: DPAPI/environment-only credentials, sanitized logs, lifecycle, duplicate start, stale nonce, and binary integrity.'
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        try { $null = Invoke-Helper 'stop' } catch { }
        $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
        $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\dearvale-sakura-test-'
        if (-not $resolvedRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected cleanup path.' }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
