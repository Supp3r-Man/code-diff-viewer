// Runs a large comparison away from the page. The page terminates this worker if it takes too long.
importScripts("diff.js");

self.onmessage = function (event) {
  const data = event.data;
  let reply;
  try {
    reply = { ok: true, result: DiffCore.compare(data.a, data.b, data.options) };
  } catch (e) {
    reply = { ok: false, message: e && e.message ? e.message : String(e) };
  }
  self.postMessage(reply);
};
