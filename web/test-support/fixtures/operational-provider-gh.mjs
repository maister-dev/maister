// A deterministic CLI provider boundary, never the user's gh installation.
const [endpoint] = process.argv.slice(2);
const response = await fetch(endpoint);
process.stdout.write(
  JSON.stringify({ status: response.status, body: await response.json() }),
);
if (!response.ok) process.exitCode = 1;
