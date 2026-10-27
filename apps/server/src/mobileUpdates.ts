import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';

/**
 * Over-the-air updates for the mobile app (Expo's update protocol, version 1). Nothing here
 * signs: the publisher on the Mac (`apps/mobile/scripts/updates.mjs`) writes each manifest or
 * directive with its signature, and the server hands out those bytes as they are. A server
 * that is broken into can stop updates but can't send phones code they would run.
 *
 * MOBILE_UPDATES_DIR holds, per runtime version and platform:
 *
 *   <runtime>/<platform>/current                     the entry phones get now (its folder name)
 *   <runtime>/<platform>/<entry>/manifest.json       an update, or directive.json (a rollback)
 *   <runtime>/<platform>/<entry>/signature           its expo-signature header value
 *   <runtime>/<platform>/<entry>/assets/<file>       the update's files (+ .br / .gz copies)
 *   no-update.json, no-update.sig                    the signed "nothing new" answer
 */

const PLATFORMS = new Set(['ios', 'android']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,79}$/;
const safe = (s: string) => SEGMENT.test(s) && !s.includes('..');

const TYPES: Record<string, string> = {
  '.hbc': 'application/javascript',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

interface Signed {
  body: string;
  signature: string;
}

async function readSigned(dir: string, file: string, sig: string): Promise<Signed | null> {
  try {
    const [body, signature] = await Promise.all([
      readFile(join(dir, file), 'utf8'),
      readFile(join(dir, sig), 'utf8'),
    ]);
    return { body, signature: signature.trim() };
  } catch {
    return null;
  }
}

function protocolHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('expo-protocol-version', '1')
    .header('expo-sfv-version', '0')
    .header('cache-control', 'private, max-age=0');
}

function multipart(
  reply: FastifyReply,
  parts: { name: string; body: string; signature?: string }[],
): FastifyReply {
  const boundary = `kovan-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const chunks = parts.map((p) =>
    [
      `--${boundary}`,
      'content-type: application/json; charset=utf-8',
      `content-disposition: form-data; name="${p.name}"`,
      ...(p.signature ? [`expo-signature: ${p.signature}`] : []),
      '',
      p.body,
    ].join('\r\n'),
  );
  return reply
    .type(`multipart/mixed; boundary=${boundary}`)
    .send(`${chunks.join('\r\n')}\r\n--${boundary}--\r\n`);
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

export function registerMobileUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const root = ctx.config.MOBILE_UPDATES_DIR ? resolve(ctx.config.MOBILE_UPDATES_DIR) : '';

  app.get('/api/mobile/updates/manifest', async (req, reply) => {
    protocolHeaders(reply);
    const platform = header(req, 'expo-platform') ?? '';
    const runtime = header(req, 'expo-runtime-version') ?? '';
    if (!PLATFORMS.has(platform) || !safe(runtime))
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Unknown platform or runtime version' } });
    // Directives (nothing new, roll back) need version 1; every expo-updates we ship speaks it.
    if (header(req, 'expo-protocol-version') !== '1')
      return reply.code(406).send({
        error: { code: 'not_acceptable', message: 'Expo update protocol 1 is required' },
      });
    const accept = header(req, 'accept') ?? '*/*';
    if (!/multipart\/mixed|\*\/\*/.test(accept))
      return reply
        .code(406)
        .send({ error: { code: 'not_acceptable', message: 'Only multipart answers are sent' } });
    if (!root) return reply.code(204).send();

    const base = join(root, runtime, platform);
    const entry = (await readFile(join(base, 'current'), 'utf8').catch(() => '')).trim();
    if (!entry || !safe(entry)) return reply.code(204).send();
    const dir = join(base, entry);
    const current = header(req, 'expo-current-update-id')?.toLowerCase();
    const nothingNew = async () => {
      const none = await readSigned(root, 'no-update.json', 'no-update.sig');
      return none
        ? multipart(reply, [{ name: 'directive', body: none.body, signature: none.signature }])
        : reply.code(204).send();
    };

    const manifest = await readSigned(dir, 'manifest.json', 'signature');
    if (manifest) {
      const id = (JSON.parse(manifest.body) as { id?: string }).id?.toLowerCase();
      if (current && id === current) return nothingNew();
      return multipart(reply, [
        { name: 'manifest', body: manifest.body, signature: manifest.signature },
        { name: 'extensions', body: JSON.stringify({ assetRequestHeaders: {} }) },
      ]);
    }
    const directive = await readSigned(dir, 'directive.json', 'signature');
    if (directive) {
      // Already on the build's own update: nothing to roll back.
      if (current && current === header(req, 'expo-embedded-update-id')?.toLowerCase())
        return nothingNew();
      return multipart(reply, [
        { name: 'directive', body: directive.body, signature: directive.signature },
      ]);
    }
    req.log.warn({ entry: dir }, 'mobile update entry has neither a manifest nor a directive');
    return reply.code(204).send();
  });

  // Files never change at their address; the manifest's hashes are what phones check.
  app.get('/api/mobile/updates/assets/:runtime/:platform/:entry/:file', async (req, reply) => {
    const { runtime, platform, entry, file } = req.params as Record<string, string>;
    if (!root || !PLATFORMS.has(platform!) || ![runtime, entry, file].every((s) => safe(s!)))
      return reply.callNotFound();
    const path = join(root, runtime!, platform!, entry!, 'assets', file!);
    const ext = /\.[A-Za-z0-9]+$/.exec(file!)?.[0].toLowerCase() ?? '';
    const accepts = header(req, 'accept-encoding') ?? '';
    for (const [encoding, suffix] of [
      ['br', '.br'],
      ['gzip', '.gz'],
      ['', ''],
    ] as const) {
      if (encoding && !new RegExp(`\\b${encoding}\\b`).test(accepts)) continue;
      const info = await stat(path + suffix).catch(() => null);
      if (!info?.isFile()) continue;
      if (encoding) reply.header('content-encoding', encoding);
      return reply
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('content-length', info.size)
        .header('vary', 'accept-encoding')
        .type(TYPES[ext] ?? 'application/octet-stream')
        .send(createReadStream(path + suffix));
    }
    return reply.callNotFound();
  });
}
