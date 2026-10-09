import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import type { CliCommand } from '../cli/args.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { resolveMetaclawDir } from '../utils/paths.js';
import { TuiClientLauncher } from './tui-client-launcher.js';
import { WebClientLauncher } from './web-client-launcher.js';

export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? '/usr/bin/open'
    : process.platform === 'win32'
      ? win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/rundll32.exe')
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
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
