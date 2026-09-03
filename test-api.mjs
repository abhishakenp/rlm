import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import { pathToFileURL } from 'node:url';

const ctx = new Context();
ctx.baseUrl = pathToFileURL('./').href;
await ctx.plugin(Loader);
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: './cordis.yml' },
});
await new Promise(r => setTimeout(r, 1000));
const entries = [...ctx.loader.entries()];
console.log('Total entries:', entries.length);
const agentEntry = entries.find(e => e.options?.id === 'agent');
console.log('Agent:', JSON.stringify(agentEntry ? {
  id: agentEntry.options?.id,
  state: agentEntry.fiber?.state
} : 'not found'));
