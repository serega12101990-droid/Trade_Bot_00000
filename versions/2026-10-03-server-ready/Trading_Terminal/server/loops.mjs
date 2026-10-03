// Serial within each job, concurrent across jobs. A slow scan must not block
// paper-position supervision or the heartbeat. No overlapping catch-up bursts.
export async function recurring(job, interval, signal, onError = console.error) {
  while (!signal.aborted) {
    try { await job(); } catch (error) { onError(error); }
    if (signal.aborted) break;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, interval);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}
