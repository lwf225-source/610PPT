// Merge task ownership with caller options; a caller must never replace the
// durable owner's cancellation signal or its child registration callbacks.
export function processOptionsWithContexts(options = {}, contexts = []) {
  const owners = [...new Set(contexts.filter(Boolean))];
  for (const owner of owners) owner.assertOwner?.();
  const signals = [...new Set([...owners.map((owner) => owner.signal), options.signal].filter(Boolean))];
  const combine = (name, hook) => {
    const callbacks = [...new Set([...owners.map((owner) => owner[name]?.bind(owner)), options[hook]].filter(Boolean))];
    if (!callbacks.length) return undefined;
    return (process) => {
      let firstError;
      for (const callback of callbacks) { try { callback(process); } catch (error) { firstError ||= error; } }
      if (firstError) throw firstError;
    };
  };
  return { ...options, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    onBeforeSpawn: combine("beforeSpawn", "onBeforeSpawn"),
    onProcessStart: combine("registerProcess", "onProcessStart"),
    onProcessEnd: combine("unregisterProcess", "onProcessEnd") };
}
