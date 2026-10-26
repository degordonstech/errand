import { buildApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./log.js";

const app = buildApp();

app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((err) => {
  logger.error({ err }, "failed to start");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
