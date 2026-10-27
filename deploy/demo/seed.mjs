// Sets up what App Store reviewers see: the review account signs in (with its password), gets
// a "Kovan Demo" workspace on the sample shop with two AI teammates and a monthly limit, and a
// machine key for the demo machine. Running it again changes nothing that is already there.
//
//   KOVAN_REVIEW_EMAIL=… KOVAN_REVIEW_PASSWORD=… node deploy/demo/seed.mjs <server> [--key-out <file>]
//
// The machine key is written to --key-out (chmod 600) as KOVAN_API_KEY=…, only when it is made.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const server = (process.argv[2] ?? '').replace(/\/$/, '');
const at = process.argv.indexOf('--key-out');
const keyOut = at === -1 ? null : process.argv[at + 1];
const email = process.env.KOVAN_REVIEW_EMAIL;
const password = process.env.KOVAN_REVIEW_PASSWORD;
if (!server || !email || !password) {
  console.error(
    'Usage: KOVAN_REVIEW_EMAIL=… KOVAN_REVIEW_PASSWORD=… node deploy/demo/seed.mjs <server>',
  );
  process.exit(1);
}

const WORKSPACE = 'Kovan Demo';
const REPO = 'https://kovan.alperkayan.dev/demo/sample-shop.git';
// Cheap, and good enough to split, review and verify small changes (gpt-oss-120b wrote the
// code but gave no verdict as a reviewer).
const MODEL = 'openai/gpt-5.6-luna';
const TEAM = [
  {
    name: 'Wren',
    instructions:
      'You lead small changes to the sample shop. Split the goal into one or two tasks, keep every change small and covered by a test, and run npm test before you call it done.',
  },
  {
    name: 'Moss',
    instructions:
      'You make small, tested changes to the sample shop. Read the code around a change first, add or update a test in test/, and run npm test.',
  },
];

async function call(token, method, path, body) {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const form = (path, fields) =>
  fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

// Signing in the way the apps do: start, the browser part (email, then the password), collect.
const secret = randomBytes(24).toString('base64url');
const { loginId } = await call(null, 'POST', '/auth/desktop/start', {
  secretHash: createHash('sha256').update(secret).digest('base64url'),
});
const page = await (await form('/auth/email', { login: loginId, email })).text();
if (!page.includes('type="password"'))
  throw new Error('The server did not ask for a password: is REVIEW_ACCOUNT_EMAIL set there?');
const signedIn = await form('/auth/review', { login: loginId, password });
if (!signedIn.ok) throw new Error(`Password refused (${signedIn.status})`);
const { token } = await call(null, 'POST', '/auth/desktop/poll', { loginId, secret });
const me = await call(token, 'GET', '/api/me');
console.log(`Signed in as ${me.user.name} <${me.user.email}>`);

const { workspaces } = await call(token, 'GET', '/api/workspaces');
let workspace = workspaces.find((w) => w.name === WORKSPACE);
if (!workspace) {
  ({ workspace } = await call(token, 'POST', '/api/workspaces', {
    orgId: me.orgs[0].id,
    name: WORKSPACE,
    repoUrl: REPO,
    defaultBranch: 'main',
  }));
  console.log(`Made the workspace ${WORKSPACE}`);
}
await call(token, 'PATCH', `/api/workspaces/${workspace.id}`, { agentMonthlyLimit: 5 });

const { agents } = await call(token, 'GET', `/api/workspaces/${workspace.id}/agents`);
for (const member of TEAM) {
  const have = agents.find((a) => a.name === member.name);
  if (have && have.model !== MODEL) {
    await call(token, 'PATCH', `/api/agents/${have.id}`, { model: MODEL });
    console.log(`${member.name} now on ${MODEL}`);
  }
  if (!have) {
    await call(token, 'POST', `/api/workspaces/${workspace.id}/agents`, {
      name: member.name,
      model: MODEL,
      instructions: member.instructions,
    });
    console.log(`Added ${member.name} (${MODEL})`);
  }
}

const { keys } = await call(token, 'GET', `/api/workspaces/${workspace.id}/api-keys`);
if (keys.some((k) => k.name === 'demo machine' && !k.revokedAt)) {
  console.log('The demo machine key exists already (revoke it in the app to make a new one).');
} else {
  const made = await call(token, 'POST', `/api/workspaces/${workspace.id}/api-keys`, {
    name: 'demo machine',
    scopes: ['machine'],
  });
  if (keyOut) {
    writeFileSync(keyOut, `KOVAN_API_KEY=${made.token}\n`, { mode: 0o600 });
    console.log(`Made the demo machine key: ${keyOut}`);
  } else console.log('Made the demo machine key (pass --key-out to keep it).');
}
console.log(
  `Workspace ${workspace.id}: limit $5 a month, team ${TEAM.map((t) => t.name).join(' + ')}`,
);
