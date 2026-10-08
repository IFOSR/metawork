# Capability diagnostics only; an unsupported directory flush is not a passed
# durability gate and must never be silently ignored in a production adapter.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable Windows runner required' }
$fixture = Join-Path $env:RUNNER_TEMP ('metawork-flush-' + [Guid]::NewGuid().ToString('N'))
$evidence = Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp/windows-desktop-validation/file-durability'
New-Item -ItemType Directory -Path $fixture | Out-Null
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FileDurabilityProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool FlushFileBuffers(SafeFileHandle handle);
  public static int Flush(string path, bool directory, bool write) {
    using (var handle = CreateFile(path, write ? 0x40000000u : 0x80000000u, 7, IntPtr.Zero, 3,
        directory ? 0x02200000u : 0x00200000u, IntPtr.Zero)) {
      if (handle.IsInvalid) return Marshal.GetLastWin32Error();
      return FlushFileBuffers(handle) ? 0 : Marshal.GetLastWin32Error();
    }
  }
}
'@
try {
  $file = Join-Path $fixture 'probe.txt'
  [IO.File]::WriteAllText($file, 'bounded durability probe')
  $result = @{
    scope = 'windows-file-flush-capability-diagnostics'
    ordinaryFileReadHandleError = [FileDurabilityProbe]::Flush($file, $false, $false)
    ordinaryFileWriteHandleError = [FileDurabilityProbe]::Flush($file, $false, $true)
    directoryReadHandleError = [FileDurabilityProbe]::Flush($fixture, $true, $false)
    directoryWriteHandleError = [FileDurabilityProbe]::Flush($fixture, $true, $true)
  }
  $result | ConvertTo-Json | Set-Content (Join-Path $evidence 'capabilities.json')
  $result | ConvertTo-Json | Write-Output
  if ($result.ordinaryFileWriteHandleError -ne 0) { throw 'Writable regular file flush failed' }
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
