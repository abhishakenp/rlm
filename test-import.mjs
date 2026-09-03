try {\n
// Test script to try importing rlm-agent
try {
  const m = await import('./packages/rlm-agent/src/index.cts').catch(() => 
    import('./packages/rlm-agent/src/index.cts')
  );
  console.log('loaded ok');
} catch(e) {
  console.error('Failed to import rlm-agent:', e.message);
  console.error('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
\n} catch(e) { console.error(e.message); process.exit(1); }