// Operator-only filesystem policy. Windows mode bits do not express an ACL.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';

// No paths or secrets are interpolated into PowerShell source/arguments. The
// fixed program receives JSON over stdin; diagnostics never return ACLs/SIDs.
const windowsPolicy = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$request.path
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]'S-1-5-18'
  $admins = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'
  $trusted = @($user.Value, $system.Value, $admins.Value)
  $installer = (New-Object Security.Principal.NTAccount('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
  $owners = $trusted + @($installer)
  function Check-Item($item, $private, $directory, $requireUserOwner = $true) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    if ($directory -ne ($item -is [IO.DirectoryInfo])) { throw 'type' }
    $acl = $item.GetAccessControl()
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (($owners -notcontains $owner) -or ($private -and $requireUserOwner -and $owner -ne $user.Value)) { throw 'owner' }
    $userFull = $false
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      $inheritOnly = ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if (!$private -and $inheritOnly) { continue }
      $sid = $rule.IdentityReference.Value
      $allow = $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
      $rights = [long]$rule.FileSystemRights
      if ($private) {
        if (!$allow -or ($trusted -notcontains $sid)) { throw 'private-acl' }
        if (!$inheritOnly -and $sid -eq $user.Value -and ($rights -band 2032127) -eq 2032127) {
          if (!$directory -or ($rule.InheritanceFlags -band 3) -eq 3) { $userFull = $true }
        }
      } elseif ($allow -and ($trusted -notcontains $sid) -and ($rights -band 1343029586) -ne 0) { throw 'ancestor-acl' }
    }
    if ($private -and !$userFull) { throw 'user-access' }
  }
  $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($path))
  if (!$drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'filesystem' }
  $chain = New-Object 'System.Collections.Generic.List[string]'
  $p = $path
  while ($p) { $chain.Insert(0,$p); $p = [IO.Path]::GetDirectoryName($p) }
  foreach ($p in $chain) {
    if ([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)) {
      $item = Get-Item -LiteralPath $p -Force
      Check-Item $item $false ($p -ne $path -or [bool]$request.directory)
    }
  }
  if ($request.operation -eq 'mkdir') {
    $missing = @($chain | Where-Object { ![IO.Directory]::Exists($_) })
    if (!$missing.Count) { Check-Item (Get-Item -LiteralPath $path -Force) $true $true }
    foreach ($p in $missing) {
      $acl = New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($user)
      $acl.SetAccessRuleProtection($true,$false)
      foreach ($sid in @($user,$system,$admins)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
      }
      [void][IO.Directory]::CreateDirectory($p,$acl)
    }
    Check-Item (Get-Item -LiteralPath $path -Force) $true $true
  } elseif ($request.operation -eq 'sqlite') {
    $parent = [IO.Path]::GetDirectoryName($path)
    if ([IO.Directory]::Exists($parent)) { Check-Item (Get-Item -LiteralPath $parent -Force) $true $true }
    elseif (!$request.initializing) { throw 'missing-directory' }
    foreach ($suffix in @('','-wal','-shm','-journal')) {
      $file = $path + $suffix
      if ([IO.File]::Exists($file) -or [IO.Directory]::Exists($file)) { Check-Item (Get-Item -LiteralPath $file -Force) $true $false }
      elseif ($suffix -eq '' -and !$request.initializing) { throw 'missing-database' }
    }
  } else {
    Check-Item (Get-Item -LiteralPath $path -Force) $true ([bool]$request.directory)
  }
  [Console]::Out.Write('ok')
} catch { [Console]::Out.Write('refused'); exit 1 }
`; // Ancestors reject deletion/replacement, data/attribute/ACL writes and generic write/all.

export function assertCanonicalPrivatePath(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0')) throw Error('Canonical absolute private path required');
  if (process.platform === 'win32') {
    // Reject UNC/device/ADS aliases, DOS devices and Win32 trailing-dot/space aliases.
    if (!/^[A-Za-z]:\\/.test(path) || path.length <= 3 || path.slice(3).split('\\').some(part =>
      !part || /[:\/?*<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw Error('Canonical local Windows path required');
    }
    if (win32.normalize(path) !== path) throw Error('Canonical local Windows path required');
    let existing = path;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw Error('Existing local Windows drive required');
      existing = parent;
    }
    if (realpathSync(existing).toLowerCase() !== existing.toLowerCase()) throw Error('Windows path aliases and reparse points are forbidden');
  }
}

function windowsCheck(operation: 'check' | 'mkdir' | 'sqlite', path: string, directory: boolean, initializing = false): void {
  assertCanonicalPrivatePath(path);
  try {
    const output = execFileSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPolicy, 'utf16le').toString('base64')], {
        input: JSON.stringify({ operation, path, directory, initializing }), encoding: 'utf8', windowsHide: true,
        timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    if (output !== 'ok') throw Error();
  } catch { throw Error('Private local NTFS path and current-user ACL required'); }
}

export function checkWindowsSQLitePath(path: string, initializing: boolean): void {
  windowsCheck('sqlite', path, false, initializing);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { if (lstatSync(path + suffix).nlink !== 1) throw Error('Single-link SQLite file required'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function assertPrivate(path: string, directory: boolean): void {
  if (process.platform === 'win32') {
    windowsCheck('check', path, directory);
    if (!directory && lstatSync(path).nlink !== 1) throw Error('Single-link private file required');
    return;
  }
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1)) {
    throw Error('Unsafe private ownership or permissions');
  }
}

export function makePrivateDirectory(path: string): void {
  if (process.platform === 'win32') windowsCheck('mkdir', path, true);
  else mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function assertPrivateFileParent(path: string): void {
  assertCanonicalPrivatePath(path);
  assertPrivate(dirname(path), true);
  try { lstatSync(path); assertPrivate(path, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
