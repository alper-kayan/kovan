import { PRODUCT_NAME } from '@kovan/shared';
import { loadConfig } from './config.js';
import { createContext } from './server.js';

const config = loadConfig();
const { app, close } = await createContext(config, { logger: true });
await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(
  `${PRODUCT_NAME} Brain on ${config.PUBLIC_URL} · GitHub ${config.githubEnabled ? 'on' : 'off'} · Google ${config.googleEnabled ? 'on' : 'off'} · mail ${config.SMTP_URL ? 'smtp' : 'dev outbox (/dev/outbox)'}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}
