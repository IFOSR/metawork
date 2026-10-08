"""Provision an isolated evaluation guest; do not publish its disk or credentials."""
import hashlib
import base64
import http.server
import json
import importlib.util
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import threading
import time
import xml.sax.saxutils

if os.environ.get('GITHUB_ACTIONS') != 'true' or not Path('/dev/kvm').exists():
    raise RuntimeError('This harness requires a disposable hosted Linux KVM runner')
root = Path(os.environ['RUNNER_TEMP']) / 'metawork-windows11'
root.mkdir()
evidence = root / 'evidence'
evidence.mkdir()
media = root / 'answer-media'
media.mkdir()
token = secrets.token_hex(24)
password = secrets.token_urlsafe(24) + 'Aa1!'
report = None


def accepted_environment(value):
    return (isinstance(value, dict)
            and value.get('scope') == 'windows11-cloud-environment'
            and value.get('passed') is True
            and 'Windows 11' in str(value.get('os', ''))
            and value.get('productType') == 1
            and value.get('secureBoot') is True
            and value.get('tpmPresent') is True
            and value.get('interactive') is True
            and value.get('screenshotCaptured') is True)


url = 'https://software-static.download.prss.microsoft.com/dbazure/26300.9457.260913-1737.26h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso'
iso = root / 'windows11-evaluation.iso'
subprocess.run(['curl', '--fail', '--location', '--retry', '2', '--max-time', '900', '--output', str(iso), url], check=True)
with iso.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
(evidence / 'image-source.json').write_text(json.dumps({
    'url': url, 'observedSha256': digest,
    'source': 'Microsoft Evaluation Center Windows 11 Enterprise x64 26H2',
    'hashAuthority': 'observed download; no separate Microsoft checksum assertion',
}, indent=2))

escape = xml.sax.saxutils.escape
command = r'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Temp\metawork-bootstrap.ps1'
copy_bootstrap = r'cmd.exe /c for %d in (D E F G H I J) do @if exist %d:\metawork-bootstrap.ps1 copy /y %d:\metawork-bootstrap.ps1 C:\Windows\Temp\metawork-bootstrap.ps1'
(media / 'Autounattend.xml').write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage><InputLocale>0409:00000409</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
        <CreatePartitions>
          <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
          <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
          <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
        </CreatePartitions>
        <ModifyPartitions>
          <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
          <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
        </ModifyPartitions>
      </Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>1</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><FullName>MetaWork CI</FullName><Organization>MetaWork evaluation</Organization></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous><RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>{escape(copy_bootstrap)}</Path></RunSynchronousCommand></RunSynchronous>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><ComputerName>MWCI</ComputerName><TimeZone>UTC</TimeZone></component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><InputLocale>0409:00000409</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale></component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>MWCI</Name><Group>Administrators</Group><DisplayName>MetaWork CI</DisplayName><Password><Value>{escape(password)}</Value><PlainText>true</PlainText></Password></LocalAccount></LocalAccounts></UserAccounts>
      <AutoLogon><Username>MWCI</Username><Enabled>true</Enabled><LogonCount>1</LogonCount><Password><Value>{escape(password)}</Value><PlainText>true</PlainText></Password></AutoLogon>
      <FirstLogonCommands><SynchronousCommand wcm:action="add"><Order>1</Order><Description>MetaWork isolated guest evidence</Description><CommandLine>{escape(command)}</CommandLine></SynchronousCommand></FirstLogonCommands>
    </component>
  </settings>
</unattend>''', encoding='utf-8')
bootstrap = Path('scripts/windows11-cloud-bootstrap.ps1').read_text().replace('@TOKEN@', token)
(media / 'metawork-bootstrap.ps1').write_text(bootstrap, encoding='utf-8-sig')
answer_iso = root / 'answers.iso'
subprocess.run(['xorriso', '-as', 'mkisofs', '-quiet', '-J', '-r', '-V', 'MWCI', '-o', str(answer_iso), str(media)], check=True)
disk = root / 'system.raw'
subprocess.run(['qemu-img', 'create', '-f', 'raw', str(disk), '64G'], check=True)
shutil.copyfile('/usr/share/OVMF/OVMF_VARS_4M.ms.fd', root / 'vars.fd')
(root / 'tpm').mkdir()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global report
        length = int(self.headers.get('Content-Length', '0'))
        if self.path not in [f'/{token}/result', f'/{token}/screen'] or not 0 < length <= 8 * 1024**2:
            self.send_error(400)
            return
        body = self.rfile.read(length)
        if self.path.endswith('/result'):
            report = json.loads(body)
            (evidence / 'windows11-guest.json').write_text(json.dumps(report, indent=2))
        else:
            (evidence / 'windows11-desktop.png').write_bytes(body)
        self.send_response(200)
        self.end_headers()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
tpm = subprocess.Popen(['swtpm', 'socket', '--tpm2', '--tpmstate', f'dir={root / "tpm"}',
    '--ctrl', f'type=unixio,path={root / "tpm.sock"}', '--flags', 'not-need-init'])
qemu = None
qmp = None
log = (evidence / 'qemu.log').open('w')
try:
    for _ in range(50):
        if (root / 'tpm.sock').exists():
            break
        if tpm.poll() is not None:
            raise RuntimeError('TPM emulator exited')
        time.sleep(0.1)
    qemu = subprocess.Popen(['qemu-system-x86_64', '-enable-kvm', '-machine', 'q35,smm=on',
        '-cpu', 'host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_time,-vmx,-svm', '-smp', '4', '-m', '8192',
        '-global', 'driver=cfi.pflash01,property=secure,value=on',
        '-drive', 'if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.ms.fd',
        '-drive', f'if=pflash,format=raw,unit=1,file={root / "vars.fd"}',
        '-chardev', f'socket,id=chrtpm,path={root / "tpm.sock"}',
        '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm', '-device', 'tpm-tis,tpmdev=tpm0',
        '-drive', f'file={disk},format=raw,if=ide,index=0,cache=writeback',
        '-drive', f'file={iso},media=cdrom,if=ide,index=2,readonly=on',
        '-drive', f'file={answer_iso},media=cdrom,if=ide,index=3,readonly=on',
        '-boot', 'order=c,once=d', '-netdev', 'user,id=net0', '-device', 'e1000e,netdev=net0',
        '-display', 'none', '-vga', 'std', '-qmp', f'unix:{root / "qmp.sock"},server=on,wait=off',
        '-serial', f'file:{evidence / "guest-serial.log"}',
    ], stdout=log, stderr=log)
    for _ in range(100):
        if (root / 'qmp.sock').exists():
            break
        if qemu.poll() is not None:
            raise RuntimeError('QEMU exited before creating its control socket')
        time.sleep(0.1)
    qmp = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    qmp.settimeout(5)
    qmp.connect(str(root / 'qmp.sock'))
    protocol = qmp.makefile('rwb', buffering=0)
    protocol.readline()

    def command(name, arguments=None):
        protocol.write((json.dumps({'execute': name, 'arguments': arguments or {}}) + '\n').encode())
        while True:
            value = json.loads(protocol.readline())
            if 'error' in value:
                raise RuntimeError(str(value['error']))
            if 'return' in value:
                return value['return']

    command('qmp_capabilities')
    for elapsed in range(45 * 60):
        if qemu.poll() is not None:
            raise RuntimeError('Windows guest VM exited unexpectedly')
        serial = evidence / 'guest-serial.log'
        if report is None and serial.exists():
            for line in serial.read_text(errors='replace').splitlines():
                if line.startswith('MWCI_REPORT=') and len(line) < 32768:
                    try:
                        candidate = json.loads(base64.b64decode(line.split('=', 1)[1], validate=True))
                        if candidate.get('scope') == 'windows11-cloud-environment' and isinstance(candidate.get('passed'), bool):
                            report = candidate
                            (evidence / 'windows11-guest.json').write_text(json.dumps(report, indent=2))
                    except (ValueError, UnicodeError):
                        pass  # A final serial line may still be in flight.
        if report is not None:
            print(json.dumps(report, indent=2), flush=True)
            if not accepted_environment(report):
                raise RuntimeError('Windows 11 environment acceptance failed')
            break
        if elapsed < 30 and elapsed % 2 == 0:
            command('human-monitor-command', {'command-line': 'sendkey ret'})
        if elapsed % 60 == 0 or (elapsed < 180 and elapsed % 10 == 0):
            print(f'Windows 11 guest provisioning: {elapsed}s; waiting for guest evidence', flush=True)
            (evidence / 'vm-status.json').write_text(json.dumps({
                'elapsedSeconds': elapsed, 'status': command('query-status'),
                'blockStats': command('query-blockstats'),
            }, indent=2))
            ppm = evidence / 'latest-console.ppm'
            # Wake display power saving without clicking or entering commands.
            command('human-monitor-command', {'command-line': 'mouse_move 1 0'})
            time.sleep(0.2)
            command('screendump', {'filename': str(ppm)})
            from PIL import Image
            with Image.open(ppm) as screenshot:
                screenshot.save(evidence / 'latest-console.png')
                if elapsed < 180:
                    screenshot.save(evidence / f'boot-{elapsed:03d}.png')
            ppm.unlink()
        if serial.exists() and 'No bootable option or device was found' in serial.read_text(errors='replace'):
            raise RuntimeError('Firmware found no bootable Windows installation; retained early setup screenshots')
        time.sleep(1)
    else:
        print('No live guest report; checking bounded on-disk evidence after VM stop', flush=True)
finally:
    if qmp:
        qmp.close()
    for child in [qemu, tpm]:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    server.shutdown()
    log.close()
    if report is None:
        spec = importlib.util.spec_from_file_location('setup_diagnostics', 'scripts/inspect-windows11-setup.py')
        diagnostics = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(diagnostics)
        report = diagnostics.inspect_setup(disk, evidence, [password, token])
    # Answer files contain a disposable guest password; only evidence is uploaded.
    shutil.rmtree(media, ignore_errors=True)
    answer_iso.unlink(missing_ok=True)
if not accepted_environment(report):
    raise RuntimeError('Windows 11 guest acceptance did not pass through live or on-disk evidence')
