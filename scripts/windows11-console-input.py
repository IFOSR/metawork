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


def launch_bootstrap(command, text):
    keys = console_keys(text)

    def press(key):
        command('human-monitor-command', {'command-line': 'sendkey ' + key + ' 20'})
        time.sleep(0.04)

    press('esc')
    press('meta_l-r')
    time.sleep(1)
    for key in keys:
        press(key)
    press('ret')
