import { App } from "./core/App.ts";

const container = document.getElementById("app");
if (!container) {
  throw new Error('Missing "#app" container element in index.html');
}

const app = new App(container);
app.start();
