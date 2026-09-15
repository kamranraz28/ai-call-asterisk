export function log(event, fields = {}) {
  const rec = { ts: new Date().toISOString(), event, ...fields };
  console.log(JSON.stringify(rec));
}
export function logError(event, err, fields = {}) {
  const rec = { ts: new Date().toISOString(), event, error: err?.message || String(err), stack: err?.stack, ...fields };
  console.error(JSON.stringify(rec));
}
