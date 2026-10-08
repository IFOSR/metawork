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
        run(['sudo', 'mount', '-t', 'ntfs-3g', '-o', 'ro,norecover', loop + 'p3', str(mount)])
        mounted = True
        for relative in ['Windows/System32/winload.efi', 'Windows/System32/config/SYSTEM',
                         'Windows/explorer.exe', 'Windows/Panther/setupact.log', 'Windows/Panther/setuperr.log',
                         'Windows/Panther/UnattendGC/setupact.log', 'Windows/Panther/UnattendGC/setuperr.log',
                         '$WINDOWS.~BT/Sources/Panther/setupact.log', '$WINDOWS.~BT/Sources/Panther/setuperr.log']:
            path = mount / relative
            if not path.is_file():
                report['files'][relative] = {'exists': False}
                continue
            item = {'exists': True, 'bytes': path.stat().st_size}
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
        # Omit command output: mount/setup diagnostics are not trusted log data.
        report['errors'].append(type(error).__name__)
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
