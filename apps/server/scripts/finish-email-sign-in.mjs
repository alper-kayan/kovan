// Development only: finishes an email sign-in from outside, the way a person would: the newest
// sign-in link mailed to <email> (from the server's /dev/outbox), the code its page asks for
// (from /dev/sign-in-code) typed into it.
//   node apps/server/scripts/finish-email-sign-in.mjs <email> [server]
const [email, server = 'http://localhost:4807'] = process.argv.slice(2);
if (!email) {
  console.error('usage: finish-email-sign-in.mjs <email> [server]');
  process.exit(2);
}
const { mail } = await (await fetch(`${server}/dev/outbox`)).json();
const sent = mail.find(
  (m) => m.to.toLowerCase() === email.toLowerCase() && /auth\/email\/callback/.test(m.text),
);
if (!sent) {
  console.error(`No sign-in mail to ${email} in ${server}/dev/outbox`);
  process.exit(1);
}
const link = new URL(/(http\S+auth\/email\/callback\S+)/.exec(sent.text)[1]);
const token = link.searchParams.get('token');
const { code } = await (
  await fetch(`${server}/dev/sign-in-code?token=${encodeURIComponent(token)}`)
).json();
if (!code) {
  console.error('The link has no sign-in waiting behind it any more.');
  process.exit(1);
}
const res = await fetch(`${server}/auth/email/confirm`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token, code }),
});
const page = await res.text();
const title = /<h1>([^<]*)<\/h1>/.exec(page)?.[1] ?? `HTTP ${res.status}`;
console.log(`${email}: ${title}`);
process.exit(res.ok ? 0 : 1);
