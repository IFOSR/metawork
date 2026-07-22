const endpoint = process.env.METACLAW_CAPABILITY_URL;
const token = process.env.METACLAW_CAPABILITY_TOKEN;

async function main(): Promise<void> {
  if (!endpoint || !token) throw new Error('capability broker binding is unavailable');
  const [capability, resource, operation, suggestedScope, ...reasonParts] = process.argv.slice(2);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ capability, resource, operation, suggestedScope, reason: reasonParts.join(' ') }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  process.stdout.write(`${body}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
