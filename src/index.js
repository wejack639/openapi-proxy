import { createApp } from "./server.js";

const host = process.env.PROXY_HOST || "127.0.0.1";
const port = Number(process.env.PROXY_PORT || 11434);

const server = createApp();
server.listen(port, host, () => {
  console.log(`openapi-proxy listening at http://${host}:${port}`);
});
