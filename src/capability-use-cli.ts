export {};

const endpoint = process.env.METACLAW_CAPABILITY_USE_URL;
const token = process.env.METACLAW_CAPABILITY_TOKEN;

async function main(): Promise<void> {
  if (!endpoint || !token) throw new Error('capability broker use binding is unavailable');
  const [grantId, ...payloadParts] = process.argv.slice(2);
  const payload = payloadParts.join(' ') || await readStdin();
  if (!grantId || !payload) throw new Error('usage: use_capability <grantId> <payload> (or pipe payload on stdin)');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ grantId, payload }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  process.stdout.write(`${body}\n`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
