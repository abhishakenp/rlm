
async function test() {
  try {
    const m = await import('./packages/rlm-agent/src/index.ts');
    console.log('loaded ok, keys:', Object.keys(m).slice(0, 10));
  } catch(e) {
    console.error('Failed to import rlm-agent:', e.message);
    console.error('Stack:', e.stack?.split('\n').slice(0, 10).join('\n'));
    process.exit(1);
  }
}
test().catch(e => { console.error('outer:', e.message); process.exit(1); });
