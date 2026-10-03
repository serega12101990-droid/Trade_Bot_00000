import { createBuilder } from 'vite';
await (await createBuilder({ configFile: 'vite.server.config.ts' })).buildApp();
