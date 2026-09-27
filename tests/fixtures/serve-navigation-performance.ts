import { createNavigationPerformanceFixture } from './navigation-performance-server.js';

const fixture = await createNavigationPerformanceFixture(process.argv[2]);
console.info(JSON.stringify({
  origin: fixture.server.address,
  fixture: 'navigation-only; execution disabled; temporary data',
}));
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void fixture.close().then(() => process.exit(0), error => {
    console.error(error);
    process.exit(1);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
