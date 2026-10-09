"""Read-only, bounded setup diagnostics after the disposable guest has stopped."""
import json
from pathlib import Path
import re
import subprocess


def inspect_setup(disk, evidence, secrets):
    mount = disk.parent / 'read-only-system'
    mount.mkdir(exist_ok=True)
    loop = None
    mounted = False
    report = {'scope': 'read-only-setup-diagnostics', 'files': {}, 'errors': []}
    guest = None
    phase = 'attach-read-only-disk'

    def run(arguments):
        return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

    def redact(line):
        # Never retain answer-file content, account credentials, tokens, encoded
        # commands or bootstrap command lines, even if setup copies them to logs.
        if re.search(r'password|autologon|commandline|encodedcommand|token|autounattend|<value>|bootstrap', line, re.I):
            return '[sensitive setup line omitted]'
        for secret in secrets:
            line = line.replace(secret, '[redacted]')
        return line[:2048]

    try:
        loop = run(['sudo', 'losetup', '--read-only', '--partscan', '--find', '--show', str(disk)])
        if not re.fullmatch(r'/dev/loop\d+', loop):
            raise RuntimeError('Unexpected loop device identity')
        phase = 'identify-system-partition'
        run(['sudo', 'udevadm', 'settle', '--timeout=10'])
        devices = json.loads(run(['lsblk', '--json', '--bytes', '--output', 'PATH,TYPE,SIZE', loop]))
        partitions = devices['blockdevices'][0].get('children', [])
        report['partitions'] = []
        ntfs = []
        for partition in partitions:
            path = partition['path']
            if partition['type'] != 'part' or not re.fullmatch(re.escape(loop) + r'p\d+', path):
                continue
            probe = subprocess.run(['sudo', 'blkid', '-p', '-s', 'TYPE', '-o', 'value', path],
                                   capture_output=True, text=True, timeout=10)
            filesystem = probe.stdout.strip()
            report['partitions'].append({'path': path, 'bytes': partition['size'],
                                         'filesystem': filesystem if re.fullmatch(r'[\w-]{1,32}', filesystem) else 'unknown'})
            if filesystem == 'ntfs':
                ntfs.append(partition)
        phase = 'mount-read-only-system'
        # A stopped evaluation guest can leave NTFS dirty; a read-only mount
        # still forbids writes, while norecover refuses even diagnostic reads.
        for partition in sorted(ntfs, key=lambda value: value['size'], reverse=True):
            run(['sudo', 'mount', '-t', 'ntfs-3g', '-o', 'ro', partition['path'], str(mount)])
            mounted = True
            if (mount / 'Windows/System32/config/SYSTEM').is_file():
                break
            run(['sudo', 'umount', str(mount)])
            mounted = False
        if not mounted:
            raise RuntimeError('No readable Windows system partition')
        phase = 'read-bounded-evidence'
        result = mount / 'Windows/Temp/metawork-guest-result.json'
        if result.is_file() and result.stat().st_size <= 32768:
            candidate = json.loads(result.read_text(encoding='utf-8-sig'))
            if candidate.get('scope') == 'windows11-cloud-environment' and isinstance(candidate.get('passed'), bool):
                guest = candidate
                (evidence / 'windows11-guest.json').write_text(json.dumps(guest, indent=2))
        screen = mount / 'Windows/Temp/metawork-guest-screen.png'
        if screen.is_file() and screen.stat().st_size <= 8 * 1024**2:
            body = screen.read_bytes()
            if body.startswith(b'\x89PNG\r\n\x1a\n'):
                (evidence / 'windows11-desktop.png').write_bytes(body)
        for relative in ['Windows/System32/winload.efi', 'Windows/System32/config/SYSTEM',
                         'Windows/Temp/metawork-bootstrap.ps1', 'Windows/Temp/metawork-guest-stage.txt',
                         'Windows/explorer.exe', 'Windows/Panther/setupact.log', 'Windows/Panther/setuperr.log',
                         'Windows/Panther/UnattendGC/setupact.log', 'Windows/Panther/UnattendGC/setuperr.log',
                         '$WINDOWS.~BT/Sources/Panther/setupact.log', '$WINDOWS.~BT/Sources/Panther/setuperr.log']:
            path = mount / relative
            if not path.is_file():
                report['files'][relative] = {'exists': False}
                continue
            item = {'exists': True, 'bytes': path.stat().st_size}
            if relative == 'Windows/Temp/metawork-guest-stage.txt' and item['bytes'] <= 1024:
                item['stage'] = redact(path.read_text(encoding='utf-8-sig', errors='replace').strip())
            if path.suffix == '.log':
                with path.open('rb') as handle:
                    handle.seek(max(0, item['bytes'] - 256 * 1024))
                    content = handle.read(256 * 1024)
                encoding = 'utf-16-le' if b'\x00' in content[:100] else 'utf-8'
                lines = content.decode(encoding, errors='replace').splitlines()
                item['diagnostics'] = [redact(line) for line in lines
                    if re.search(r'error|fail|0x[0-9a-f]{8}|reboot|phase|specialize|oobe', line, re.I)][-120:]
            report['files'][relative] = item
    except Exception as error:
        failure = {'phase': phase, 'type': type(error).__name__}
        # These two fixed OS commands only attach/mount the disk. Preserve their
        # bounded diagnostics; never include setup command lines or file contents.
        if isinstance(error, subprocess.CalledProcessError) and phase in ['attach-read-only-disk', 'mount-read-only-system']:
            failure['exitCode'] = error.returncode
            failure['diagnostics'] = [redact(line) for line in (error.stderr or '').splitlines()[:8]]
        report['errors'].append(failure)
    finally:
        if mounted:
            try:
                run(['sudo', 'umount', str(mount)])
            except Exception as error:
                report['errors'].append('unmount: ' + type(error).__name__)
        if loop:
            try:
                run(['sudo', 'losetup', '--detach', loop])
            except Exception as error:
                report['errors'].append('detach: ' + type(error).__name__)
        (evidence / 'setup-diagnostics.json').write_text(json.dumps(report, indent=2))
    return guest
