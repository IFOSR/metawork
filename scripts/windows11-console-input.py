"""Type a bounded bootstrap command through the disposable guest's US keyboard."""
import time


def console_keys(text):
    if not text or len(text) > 1024:
        raise ValueError('Bounded bootstrap command required')
    punctuation = {' ': 'spc', '-': 'minus', '.': 'dot', '/': 'slash',
                   '=': 'equal', '+': 'shift-equal'}
    keys = []
    for character in text:
        if 'A' <= character <= 'Z':
            keys.append('shift-' + character.lower())
        elif 'a' <= character <= 'z' or '0' <= character <= '9':
            keys.append(character)
        elif character in punctuation:
            keys.append(punctuation[character])
        else:
            raise ValueError('Unsupported bootstrap keyboard character')
    return keys


def launch_bootstrap(command, text, snapshot=lambda stage: None):
    keys = console_keys(text)

    def press(key):
        # QEMU key releases use guest-clock timers. Allow the guest to observe
        # the whole chord before sending another key, even during first login.
        command('human-monitor-command', {'command-line': 'sendkey ' + key + ' 100'})
        time.sleep(0.2)

    press('esc')
    press('meta_l-d')
    time.sleep(2)
    press('meta_l-r')
    time.sleep(3)
    snapshot('run-dialog')
    press('ctrl-a')
    # The Run dialog has a much shorter command limit than a PowerShell
    # terminal. Environment facts are readable without elevation.
    for key in console_keys('powershell.exe -NoProfile -ExecutionPolicy Bypass'):
        press(key)
    press('ret')
    time.sleep(5)
    snapshot('powershell')
    for key in keys:
        press(key)
    press('ret')
    time.sleep(10)
    snapshot('executed')
