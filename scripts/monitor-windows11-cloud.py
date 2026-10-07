"""Run the VM harness across steps so setup screenshots can be inspected live."""
import os
from pathlib import Path
import subprocess
import sys
import time

if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise RuntimeError('Disposable Actions host required')
root = Path(os.environ['RUNNER_TEMP'])
status = root / 'metawork-windows11-status'
if sys.argv[1] == 'start':
    wrapper = root / 'metawork-windows11-runner.py'
    wrapper.write_text('''import os, subprocess, sys
from pathlib import Path
code = subprocess.call([sys.executable, '-u', 'scripts/probe-windows11-cloud.py'])
(Path(os.environ['RUNNER_TEMP']) / 'metawork-windows11-status').write_text(str(code))
''')
    log = (root / 'metawork-windows11-provisioning.log').open('w')
    child = subprocess.Popen([sys.executable, str(wrapper)], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (root / 'metawork-windows11-controller.pid').write_text(str(child.pid))
    print('Disposable Windows 11 provisioning started')
else:
    deadline = time.monotonic() + int(sys.argv[2])
    while not status.exists() and time.monotonic() < deadline:
        time.sleep(5)
    log = root / 'metawork-windows11-provisioning.log'
    if log.exists():
        print('\n'.join(log.read_text(errors='replace').splitlines()[-12:]))
    if sys.argv[1] == 'finish':
        if not status.exists():
            raise RuntimeError('Windows 11 provisioning did not finish within its budget')
        sys.exit(int(status.read_text()))
