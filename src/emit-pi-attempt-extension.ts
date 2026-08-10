import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PI_WEB_EXTENSION_SOURCE } from './executor/pi-agent.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('output path is required');
writeFileSync(resolve(outputPath), PI_WEB_EXTENSION_SOURCE, 'utf8');
