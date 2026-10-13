const container = document.getElementById("app");
if (!container) {
  throw new Error('Missing "#app" container element in index.html');
}

// A failed start otherwise leaves a silent black page; show the reason instead.
function showStartupError(error: unknown): void {
  if (document.getElementById("startup-error")) return;
  const box = document.createElement("pre");
  box.id = "startup-error";
  box.style.cssText =
    "position:fixed;inset:24px;margin:0;padding:20px;overflow:auto;z-index:99999;white-space:pre-wrap;" +
    "background:#1a0f0f;color:#ffd9d0;border:1px solid #a33;border-radius:8px;font:14px/1.5 ui-monospace,Consolas,monospace";
  const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  const webgl = document.createElement("canvas").getContext("webgl2") ? "available" : "NOT available — enable hardware acceleration in the browser";
  box.textContent = `The world failed to start.\n\nWebGL2: ${webgl}\n\n${detail}`;
  document.body.appendChild(box);
}

let started = false;
const onError = (event: ErrorEvent) => { if (!started) showStartupError(event.error ?? event.message); };
const onRejection = (event: PromiseRejectionEvent) => { if (!started) showStartupError(event.reason); };
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

import("./core/App.ts")
  .then(({ App }) => {
    new App(container).start();
    window.setTimeout(() => {
      started = true;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }, 30_000);
  })
  .catch((error: unknown) => {
    showStartupError(error);
    console.error(error);
  });
