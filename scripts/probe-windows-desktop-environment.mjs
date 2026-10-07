// P0 environment evidence, not Desktop or local-authentication acceptance.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, symlink, rename, unlink, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows Desktop environment probe requires native Windows x64 Node');
}
const evidence = resolve(process.argv[2] ?? '.tmp/windows-desktop-validation/windows-environment.json');
const root = await mkdtemp(join(tmpdir(), 'metawork-windows-probe-'));
const env = { ...process.env, METAWORK_WINDOWS_PROBE_ROOT: root };
// A pwsh runner exports its own module locations; Windows PowerShell must load
// the inbox .NET Framework security module instead of the PowerShell 7 one.
for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; ${script}`], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  }).trim();
}
const checks = [];
async function check(name, action) {
  try { checks.push({ name, passed: true, facts: await action() }); }
  catch (error) { checks.push({ name, passed: false, message: error.message }); }
}
let host;
try {
  host = JSON.parse(powershell(`
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $os = Get-CimInstance Win32_OperatingSystem
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($env:METAWORK_WINDOWS_PROBE_ROOT))
    [ordered]@{
      os = $os.Caption; build = $os.BuildNumber; productType = $os.ProductType
      elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      interactive = [Environment]::UserInteractive; filesystem = $drive.DriveFormat
    } | ConvertTo-Json -Compress
  `));
  await check('NTFS local test volume', async () => {
    if (host.filesystem !== 'NTFS') throw new Error('The probe requires NTFS');
    return host.filesystem;
  });
  await check('file and directory symlink plus release pointer replacement', async () => {
    const directory = join(root, '中文 workspace with spaces');
    await mkdir(directory);
    await writeFile(join(directory, 'old.db'), 'old-fixture');
    await writeFile(join(directory, 'new.db'), 'new-fixture');
    const current = join(root, 'current.db');
    const pending = join(root, 'pending.db');
    await symlink(join(directory, 'old.db'), current, 'file');
    await symlink(join(directory, 'new.db'), pending, 'file');
    await rename(pending, current);
    if (await readFile(current, 'utf8') !== 'new-fixture') throw new Error('File pointer promotion failed');
    const directoryLink = join(root, 'current-directory');
    await symlink(directory, directoryLink, 'dir');
    if (await readFile(join(directoryLink, 'old.db'), 'utf8') !== 'old-fixture') throw new Error('Directory link failed');
    await unlink(current);
    await unlink(directoryLink);
    return { unicodeAndSpaces: true, ordinaryUserVerified: !host.elevated };
  });
  await check('protected directory ACL inherited by an atomically replaced file', async () => {
    // Only fixture bytes are written. This is not a production ACL initializer.
    return JSON.parse(powershell(`
      $path = Join-Path $env:METAWORK_WINDOWS_PROBE_ROOT 'private'
      New-Item -ItemType Directory -Path $path | Out-Null
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($account in @($sid, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $path -AclObject $acl
      $current = Join-Path $path 'current.json'
      $pending = Join-Path $path 'pending.json'
      [IO.File]::WriteAllText($current, 'old-fixture')
      [IO.File]::WriteAllText($pending, 'new-fixture')
      # An elevated token may default file ownership to Administrators. Pin the
      # owner explicitly before promotion, within the already private directory.
      foreach ($file in @($current, $pending)) {
        $fileAcl = Get-Acl -LiteralPath $file
        $fileAcl.SetOwner($sid)
        Set-Acl -LiteralPath $file -AclObject $fileAcl
      }
      # Windows PowerShell coerces $null to an empty string for this overload.
      # Use an explicit backup in the same private directory.
      [IO.File]::Replace($pending, $current, (Join-Path $path 'backup.json'))
      $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
      foreach ($file in @($path, $current, (Join-Path $path 'backup.json'))) {
        $actual = Get-Acl -LiteralPath $file
        if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
        foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
          if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Unexpected allowed identity' }
        }
      }
      if (-not (Get-Acl -LiteralPath $path).AreAccessRulesProtected) { throw 'Inherited directory permissions remain enabled' }
      if ([IO.File]::ReadAllText($current) -ne 'new-fixture') { throw 'Replacement failed' }
      @{ protectedDirectory = $true; fileReplacement = $true; crossAccountAccessVerified = $false } | ConvertTo-Json -Compress
    `));
  });
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(resolve(evidence, '..'), { recursive: true });
  const report = {
    scope: 'environment-probe-only', platform: process.platform, arch: process.arch,
    node: process.version, osRelease: release(), host, checks,
    p0Accepted: false, windows11Acceptance: false,
    remaining: ['restricted pipe native adapter and peer identity', 'cross-account access denial',
      'pipe squatting and remote-client denial', 'ordinary-user clean installation',
      'packaged Electron and real model tasks', 'Windows 11 GUI installation/update/rollback'],
  };
  await writeFile(evidence, JSON.stringify(report, null, 2));
  process.stdout.write(`Windows environment evidence: ${evidence}; P0 acceptance remains open.\n`);
}
if (checks.some(result => !result.passed)) process.exitCode = 1;
