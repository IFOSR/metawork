// Handle/ACL/reparse P0 cases using only generated fixture bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export async function probePrivateFiles(addon, evidence) {
  const root = await mkdtemp(join(tmpdir(), 'metawork-private-p0-'));
  const env = { ...process.env, METAWORK_P0_PRIVATE_ROOT: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $root=$env:METAWORK_P0_PRIVATE_ROOT; ${script}`], { env, encoding: 'utf8', timeout: 30_000 });
  const checks = [];
  const check = (name, action) => { action(); checks.push(name); };
  let worker;
  let control;
  try {
    ps(`
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl=New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
      foreach($account in @($sid,[Security.Principal.SecurityIdentifier]'S-1-5-18',[Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
      }
      Set-Acl -LiteralPath $root -AclObject $acl
    `);
    await mkdir(join(root, '中文 child'));
    await writeFile(join(root, '中文 child', 'endpoint.json'), 'private-fixture');
    await writeFile(join(root, 'large.json'), Buffer.alloc(65537));
    await writeFile(join(root, 'broad.json'), 'must-be-rejected');
    await writeFile(join(root, 'race.json'), 'private-fixture');
    await writeFile(join(root, 'outside.json'), 'outside-fixture');
    ps(`
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
      Get-ChildItem -LiteralPath $root -Recurse | ForEach-Object {
        $acl=Get-Acl -LiteralPath $_.FullName; $acl.SetOwner($sid); Set-Acl -LiteralPath $_.FullName -AclObject $acl
      }
      $path=Join-Path $root 'broad.json'; $acl=Get-Acl -LiteralPath $path
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]'S-1-5-11','Read','Allow')))
      Set-Acl -LiteralPath $path -AclObject $acl
    `);
    check('bounded private Unicode file', () => assert.equal(addon.readPrivateFile(root, '中文 child\\endpoint.json').toString(), 'private-fixture'));
    check('untrusted allowed ACE refused', () => assert.throws(() => addon.readPrivateFile(root, 'broad.json'), /ACL/));
    check('oversized file refused', () => assert.throws(() => addon.readPrivateFile(root, 'large.json'), /size/));
    for (const name of ['..\\outside.json', 'C:\\outside.json', '中文 child\\..\\outside.json', 'endpoint.json\0other']) {
      check('unsafe relative path refused', () => assert.throws(() => addon.readPrivateFile(root, name)));
    }
    await symlink(join(root, 'outside.json'), join(root, 'file-link.json'), 'file');
    await symlink(join(root, '中文 child'), join(root, 'directory-link'), 'dir');
    await link(join(root, 'outside.json'), join(root, 'hard-link.json'));
    check('file reparse refused', () => assert.throws(() => addon.readPrivateFile(root, 'file-link.json'), /reparse/));
    check('directory reparse refused', () => assert.throws(() => addon.readPrivateFile(root, 'directory-link\\endpoint.json'), /reparse/));
    check('hard link refused', () => assert.throws(() => addon.readPrivateFile(root, 'hard-link.json'), /hard links/));
    await rm(join(root, 'hard-link.json'));
    check('root redirection refused', () => assert.throws(() => addon.readPrivateFile(join(root, 'directory-link'), 'endpoint.json'), /reparse/));
    ps(`
      $name='mwf'+[Guid]::NewGuid().ToString('N').Substring(0,10)
      $fixture=Join-Path $env:PUBLIC $name; $created=$false; $child=$null
      try {
        $password=ConvertTo-SecureString ([Guid]::NewGuid().ToString('N')+'Aa!7') -AsPlainText -Force
        New-LocalUser -Name $name -Password $password | Out-Null; $created=$true
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
        $credential=New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\\$name",$password)
        New-Item -ItemType Directory -Path $fixture | Out-Null
        & icacls.exe $fixture /grant "\${name}:(OI)(CI)M" | Out-Null
        if($LASTEXITCODE -ne 0) { throw 'Cross-account file fixture ACL failed' }
        $script=Join-Path $fixture 'probe.ps1'
        @'
param([string]$Target)
try { [IO.File]::ReadAllText($Target) | Out-Null; '{"denied":false}' ; exit 1 }
catch {
  $cause=$_.Exception.GetBaseException()
  if ($cause -is [UnauthorizedAccessException]) { '{"denied":true}'; exit 0 }
  @{ denied=$false; exception=$cause.GetType().FullName; hresult=$cause.HResult } | ConvertTo-Json -Compress
  exit 2
}
'@ | Set-Content -LiteralPath $script
        $target=Join-Path $root '中文 child\\endpoint.json'
        $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-Target',('"'+$target+'"'))
        $out=Join-Path $fixture 'result.json'; $err=Join-Path $fixture 'error.txt'
        $child=Start-Process powershell.exe -Credential $credential -WorkingDirectory $fixture -ArgumentList $arguments -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null=$child.Handle
        if(-not $child.WaitForExit(15000)) { $child.Kill(); throw 'Cross-account file read timed out' }
        $result=Get-Content -LiteralPath $out -Raw
        if($child.ExitCode -ne 0 -or ($result | ConvertFrom-Json).denied -ne $true) {
          $diagnostic=Get-Content -LiteralPath $err -Raw
          throw "Cross-account file read failed: exit=$($child.ExitCode); result=$result; error=$diagnostic"
        }
      } finally {
        if($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        if($created) { Remove-LocalUser -Name $name }
        if(Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
      }
    `);
    checks.push('another standard account cannot read private fixture');
    // A concurrent worker alternates a regular fixture with a reparse point.
    // The main thread may read the validated fixture or fail closed, never the target.
    control = new Int32Array(new SharedArrayBuffer(16));
    worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const fs = require('node:fs'); const path = require('node:path');
      const state = new Int32Array(workerData.control);
      const target = path.join(workerData.root, 'race.json');
      const pending = path.join(workerData.root, 'race-pending.json');
      const parked = path.join(workerData.root, 'race-regular.json');
      parentPort.postMessage('ready');
      while (!Atomics.load(state, 0)) {
        try {
          if (fs.existsSync(parked)) {
            fs.renameSync(parked, target); Atomics.add(state, 1, 1);
            Atomics.wait(state, 3, 0, 1);
            continue;
          }
          fs.renameSync(target, parked);
          fs.rmSync(pending, { force: true });
          fs.symlinkSync(path.join(workerData.root, 'outside.json'), pending, 'file');
          fs.renameSync(pending, target); Atomics.add(state, 1, 1);
          Atomics.wait(state, 3, 0, 1);
          // Preserve the original validated owner/ACL when restoring a regular
          // file; a newly created elevated file could invalidate every read.
          fs.renameSync(parked, target); Atomics.add(state, 1, 1);
          Atomics.wait(state, 3, 0, 1);
        } catch { Atomics.add(state, 2, 1); }
      }
    `, { eval: true, workerData: { root, control: control.buffer } });
    await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    const raceDeadline = Date.now() + 5000;
    while (Atomics.load(control, 1) === 0) {
      if (Date.now() >= raceDeadline) throw Error('Replacement worker did not become active');
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    let rejected = 0;
    let successful = 0;
    for (let attempt = 0; attempt < 500; attempt++) {
      let bytes;
      try { bytes = addon.readPrivateFile(root, 'race.json'); } catch { rejected++; continue; }
      assert.equal(bytes.toString(), 'private-fixture');
      successful++;
    }
    Atomics.store(control, 0, 1);
    await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
    assert.ok(Atomics.load(control, 1) > 0, 'Concurrent replacement must actually run');
    assert.ok(successful > 0 && rejected > 0, 'Race must exercise both valid reads and refused replacements');
    checks.push('concurrent reparse replacement never returns target bytes');
    await writeFile(join(evidence, 'private-files.json'), JSON.stringify({
      scope: 'private-file-native-spike', passed: true, checks, rejectedReads: rejected, successfulReads: successful,
      replacements: Atomics.load(control, 1), p0Accepted: false,
      remaining: ['production file creation and replacement adapter'],
    }, null, 2));
  } finally {
    if (control) Atomics.store(control, 0, 1);
    if (worker) await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
}
