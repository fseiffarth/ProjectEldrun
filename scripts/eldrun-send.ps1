# Windows twin of eldrun-send.sh. Binary stdin is read without text conversion.
$ErrorActionPreference = 'Stop'
function Fail($Code, $Message) { [Console]::Error.WriteLine("eldrun-send: $Message"); exit $Code }
if ($args.Count -eq 0 -or $args[0] -eq '--help') {
    Write-Output "eldrun-send FILE...`ncommand | eldrun-send -n NAME`neldrun-send --clear"
    if ($args.Count -eq 0) { exit 2 }; exit 0
}
$fromStdin = $args[0] -eq '-n'
$clear = $args[0] -eq '--clear'
if (($fromStdin -and $args.Count -ne 2) -or ($clear -and $args.Count -ne 1)) { Fail 2 'Invalid arguments; use --help.' }
if ($args[0].StartsWith('-') -and -not $fromStdin -and -not $clear -and $args[0] -ne '--') { Fail 2 'Unknown option; use --help.' }
if ($args[0] -eq '--') { $args = @($args | Select-Object -Skip 1) }
$root = $env:ELDRUN_PROJECT_DIR
if (-not $root) {
    try { $root = & git rev-parse --show-toplevel 2>$null }
    catch { Fail 3 'Set ELDRUN_PROJECT_DIR or run inside a git project.' }
}
if (-not $root -or -not [IO.Directory]::Exists($root)) { Fail 3 'Set ELDRUN_PROJECT_DIR or run inside a git project.' }
$root = [IO.Path]::GetFullPath($root)
$outbox = Join-Path $root '.eldrun/outbox'
foreach ($dir in @((Join-Path $root '.eldrun'), $outbox)) {
    if ((Test-Path -LiteralPath $dir) -and ((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 3 'The outbox must not be a symlink.' }
}
try { [void][IO.Directory]::CreateDirectory($outbox) }
catch { Fail 3 'Cannot create the project outbox.' }
if ($clear) {
    Get-ChildItem -Force -LiteralPath $outbox -File | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Remove-Item -Force
    Write-Output 'eldrun-send: outbox cleared.'; exit 0
}
$ignored = $false
try { & git -C $root check-ignore -q .eldrun/ 2>$null; $ignored = $LASTEXITCODE -eq 0 } catch {}
if (-not $ignored) { [Console]::Error.WriteLine('eldrun-send: warning: .eldrun/ is not git-ignored; ignore it before committing.') }
$sources = if ($fromStdin) { @($args[1]) } else { @($args) }
foreach ($source in $sources) {
    $inputStream = $null; $outputStream = $null
    $stage = Join-Path $outbox ('.send-' + [guid]::NewGuid().ToString('N'))
    try {
        if ($fromStdin) { $inputStream = [Console]::OpenStandardInput() }
        else {
            if (-not [IO.File]::Exists($source)) { Fail 4 'Only regular files can be sent.' }
            $inputStream = [IO.File]::OpenRead([IO.Path]::GetFullPath($source))
        }
        $outputStream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew)
        $buffer = New-Object byte[] 65536
        $size = 0
        while (($count = $inputStream.Read($buffer, 0, [Math]::Min($buffer.Length, 25165825 - $size))) -gt 0) {
            $outputStream.Write($buffer, 0, $count); $size += $count
            if ($size -gt 25165824) { break }
        }
        $outputStream.Dispose(); $outputStream = $null
        if ($size -eq 0 -or $size -gt 25165824) { Fail 4 'Files must be nonempty and at most 24 MiB.' }
        $name = ([IO.Path]::GetFileName($source) -replace '[^A-Za-z0-9._-]', '_').TrimStart('.')
        if (-not $name) { $name = 'file' }
        $ext = [IO.Path]::GetExtension($name)
        if ($ext.Length -gt 16) { $ext = $ext.Substring(0,16) }
        $stem = [IO.Path]::GetFileNameWithoutExtension($name)
        if ($stem.Length -gt (80 - $ext.Length)) { $stem = $stem.Substring(0, 80 - $ext.Length) }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $suffix = ''; $n = 0
        while ($true) {
            $leaf = "$stamp-$stem$suffix$ext"
            $dest = Join-Path $outbox $leaf
            try { [IO.File]::Move($stage, $dest); break }
            catch [IO.IOException] { if (-not (Test-Path -LiteralPath $dest)) { throw }; $n++; $suffix = "-$n" }
        }
        Write-Output "phone: $leaf ($([Math]::Ceiling($size / 1024)) KB) - preview or download (the phone checks its bytes)"
    } catch { Fail 4 $_.Exception.Message }
    finally {
        if ($inputStream) { $inputStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
        if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
    }
}
