import fs from 'node:fs';
const file = '/home/xlsun/metawork/src/management/server.ts';
let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
if (text.includes('/tmp/official-auth-error.log')) { console.log('ALREADY PATCHED'); process.exit(0); }
const marker = `    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = code === 'already_logged_in' ? 409`;
if (!text.includes(marker)) { console.error('catch marker not found'); process.exit(1); }
const injected = `    } catch (error) {
      try { (await import('node:fs')).appendFileSync('/tmp/official-auth-error.log', JSON.stringify({ message: (error as Error)?.message, stack: (error as Error)?.stack }) + '\\n'); } catch {}
      const code = (error as { code?: string }).code;
      const status = code === 'already_logged_in' ? 409`;
text = text.replace(marker, injected);
fs.writeFileSync(file, text);
console.log('PATCHED');
