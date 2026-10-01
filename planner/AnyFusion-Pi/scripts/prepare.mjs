// Production installs need dependency lifecycle scripts, but not development hooks.
if (process.env.NODE_ENV !== 'production' && process.env.CI !== 'true' && process.env.HUSKY !== '0') {
  const { default: husky } = await import('husky');
  const message = husky();
  if (message) console.log(message);
}
