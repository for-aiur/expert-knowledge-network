const base = new URL(process.env.EKN_URL ?? 'http://localhost:8788');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Load smoke is local-only.');
const iterations = Number(process.env.EKN_LOAD_ITERATIONS ?? 10);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Invalid EKN_LOAD_ITERATIONS.');

async function run(virtualUsers) {
  const samples = [];
  let errors = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: virtualUsers }, async () => {
    for (let i = 0; i < iterations; i++) {
      const since = performance.now();
      try {
        const response = await fetch(new URL('/api/v1/repairs?limit=20', base));
        if (!response.ok) errors++;
        await response.arrayBuffer();
        samples.push(performance.now() - since);
      } catch { errors++; }
    }
  }));
  const elapsed = (performance.now() - started) / 1000;
  samples.sort((a, b) => a - b);
  const percentile = fraction => samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)] ?? 0;
  console.log(JSON.stringify({ virtual_users: virtualUsers, requests: samples.length, errors,
    elapsed_seconds: Number(elapsed.toFixed(2)), throughput_rps: Number((samples.length / elapsed).toFixed(1)),
    latency_ms: { p50: Number(percentile(.5).toFixed(1)), p95: Number(percentile(.95).toFixed(1)),
      max: Number((samples.at(-1) ?? 0).toFixed(1)) } }, null, 2));
}

for (const users of [100, 500]) await run(users);
