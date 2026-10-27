// The update key: an Ed25519 pair. The private half signs update manifests when a release is
// published; the public half is built into the app, which refuses a Linux update that isn't
// signed with it (an AppImage has no OS signature to check).
//
//   node scripts/update-key.mjs generate
//       prints KOVAN_UPDATE_PRIVATE_KEY and KOVAN_UPDATE_PUBLIC_KEY. Keep the private one in
//       the release secrets only; it is never written to disk here.
//   KOVAN_UPDATE_PRIVATE_KEY=… node scripts/update-key.mjs sign release/latest-linux.yml
//       writes release/latest-linux.yml.sig
//   KOVAN_UPDATE_PUBLIC_KEY=… node scripts/update-key.mjs verify release/latest-linux.yml
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [command, file] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (command === 'generate') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log(
    `KOVAN_UPDATE_PRIVATE_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`,
  );
  console.log(
    `KOVAN_UPDATE_PUBLIC_KEY=${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`,
  );
} else if (command === 'sign' && file) {
  const secret = process.env.KOVAN_UPDATE_PRIVATE_KEY;
  if (!secret) fail('KOVAN_UPDATE_PRIVATE_KEY is not set');
  const key = createPrivateKey({
    key: Buffer.from(secret, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  writeFileSync(`${file}.sig`, sign(null, readFileSync(file), key).toString('base64') + '\n');
  console.log(`Signed ${file}`);
} else if (command === 'verify' && file) {
  const pub = process.env.KOVAN_UPDATE_PUBLIC_KEY;
  if (!pub) fail('KOVAN_UPDATE_PUBLIC_KEY is not set');
  const key = createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
  const signature = Buffer.from(readFileSync(`${file}.sig`, 'utf8').trim(), 'base64');
  if (!verify(null, readFileSync(file), key, signature)) fail(`BAD signature on ${file}`);
  console.log(`Good signature on ${file}`);
} else {
  fail('usage: update-key.mjs generate | sign <file> | verify <file>');
}
