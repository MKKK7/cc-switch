import { pathToFileURL } from 'node:url';
import { createAdapter } from '../trae-adapter/server.mjs';
import { CommandCodeClient, bridgeCommandCode } from './client.mjs';

export function startCommandCode({ key, port = 18789, client = new CommandCodeClient(), providerAuth = true }) {
  return createAdapter({ client, key, port, supportedModels: null, transformResponse: bridgeCommandCode, serviceName: 'CommandCode',
    requestClient: providerAuth ? token => new CommandCodeClient({ credential: async () => token }) : undefined });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const adapter = await startCommandCode({ key: process.env.CC_TRAE_KEY, port: Number(process.env.CC_TRAE_PORT ?? 18789) });
    console.log(JSON.stringify({ port: adapter.port, models: adapter.models }));
    if (process.env.CC_TRAE_MANAGED === '1') {
      process.stdin.resume();
      process.stdin.on('end', () => { adapter.server.closeAllConnections(); adapter.server.close(); });
    }
  } catch {
    console.error('CommandCode startup failed. Check Node 24, proxy and port.');
    process.exitCode = 1;
  }
}
