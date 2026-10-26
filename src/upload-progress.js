/** Deadline follows upload progress, then bounds the wait for the response. */
export function progressUpload(body, { stallTimeoutMs = 60000, responseTimeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  let timer;
  const arm = milliseconds => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('File transfer timed out without progress.')), milliseconds);
    timer.unref?.();
  };
  arm(stallTimeoutMs);
  const stream = async function* () {
    try {
      for await (const chunk of body) {
        arm(stallTimeoutMs);
        yield chunk;
      }
      arm(responseTimeoutMs);
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  return { body: stream(), signal: controller.signal, close: () => clearTimeout(timer) };
}

