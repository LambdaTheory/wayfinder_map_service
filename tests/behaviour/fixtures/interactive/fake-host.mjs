// A service-only integration test: the client launcher is never invoked and no personal configuration is read.
import { host } from '../../interactive/host.ts';
await host(process.argv.slice(2), () => ({ configs: {}, everyday: { known: false, reason: 'synthetic observer has no daily service access' } }));
