import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliCommand } from '../cli/args.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import { TuiClientLauncher } from './tui-client-launcher.js';
import { WebClientLauncher } from './web-client-launcher.js';

export function openBrowser(url: string): void {
  // `start` is a cmd.exe builtin, not an executable, so Windows must go through
  // cmd. The empty quoted argument is the window title slot that `start` would
  // otherwise fill with the URL itself. The URL is passed as an argv entry, not
  // interpolated into a shell command line.
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]] as const
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '""', url]] as const
      : ['xdg-open', [url]] as const;
  spawn(command, [...args], { stdio: 'ignore', detached: true }).unref();
}

export async function runClientCommand(command: Extract<CliCommand, { kind: 'tui' | 'web' }>): Promise<void> {
  const paths = resolveMetaWorkPaths();
  const metaclawDir = resolveMetaclawDir();
  const endpointManifestPath = resolve(paths.root, 'server-endpoint.json');
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });

  if (command.kind === 'tui') {
    await new TuiClientLauncher({
      manifestPath: endpointManifestPath,
      conversationId: command.conversationId,
    }).start();
    return;
  }

  const origin = await new WebClientLauncher({
    manifestPath: endpointManifestPath,
    open: openBrowser,
  }).start({
    conversationId: command.conversationId,
    noOpen: command.noOpen === true,
  });
  process.stdout.write(`MetaWork Web Client: ${origin}\n`);
}
