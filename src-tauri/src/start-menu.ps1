$ErrorActionPreference = 'Stop'
$exe = $env:CACHECAPSULE_EXE
$programs = $env:CACHECAPSULE_PROGRAMS
if (-not $programs) { $programs = [Environment]::GetFolderPath('Programs') }
if (-not $exe -or -not $programs) { throw 'Missing executable or Start Menu directory' }
[IO.Directory]::CreateDirectory($programs) | Out-Null
$path = Join-Path $programs 'CacheCapsule.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
$working = Split-Path -Parent $exe
$icon = $exe + ',0'
if (-not (Test-Path -LiteralPath $path) -or $link.TargetPath -ne $exe -or
    $link.WorkingDirectory -ne $working -or $link.IconLocation -ne $icon -or $link.Arguments) {
    $link.TargetPath = $exe
    $link.Arguments = ''
    $link.WorkingDirectory = $working
    $link.IconLocation = $icon
    $link.Description = 'CacheCapsule'
    $link.Save()
}
