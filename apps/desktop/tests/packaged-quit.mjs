import assert from 'node:assert/strict';

// Return from the debugger request before quitting Main, then observe the OS
// process. Waiting for a debugger response while app.quit closes it can hang.
export async function quitPackagedDesktop(application) {
  const child = application.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once('exit', code => done(code)));
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  let timer;
  try {
    assert.equal(await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Desktop graceful exit timed out')), 30000);
    })]), 0);
  } finally { clearTimeout(timer); }
}
