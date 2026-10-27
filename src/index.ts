import path from "node:path";

import { loadConfig } from "./config.js";
import { createApp } from "./http/server.js";
import { OUTBOUND_BEARER_ENV } from "./outbound/constants.js";
import { outboundClientFor } from "./outbound/twilio-client.js";
import { logError, logInfo, logWarn, registerSecrets } from "./logger.js";
import { CallStore } from "./store/calls.js";
import { summaryAuthorizationValue } from "./summary/deliver.js";

const config = loadConfig();
const summaryAuthHeader = config.summaryWebhookAuth
  ? summaryAuthorizationValue(config.summaryWebhookAuth)
  : undefined;
registerSecrets([
  config.xaiApiKey,
  config.twilioAuthToken,
  config.twilioAccountSid,
  config.summaryWebhookSecret,
  summaryAuthHeader,
  config.summaryWebhookAuth,
  config.messagesBearerToken,
  process.env[OUTBOUND_BEARER_ENV],
]);

if (config.production && !config.twilioAuthToken) {
  logWarn("production is missing TWILIO_AUTH_TOKEN; voice webhooks will be rejected");
}
if (config.production && !config.xaiApiKey) {
  logWarn("production is missing XAI_API_KEY; calls will be ended");
}
if (!config.messagesBearerToken) {
  logWarn("MESSAGES_BEARER_TOKEN is unset; GET /messages will reject every request");
}
if (config.allowInsecureDevWebhook && config.production) {
  logWarn("ALLOW_INSECURE_DEV_WEBHOOK is ignored in production");
} else if (config.allowInsecureDevWebhook) {
  logWarn("ALLOW_INSECURE_DEV_WEBHOOK is enabled; unsigned webhooks are accepted");
}

const store = new CallStore(path.join(config.dataDir, "calls.json"), config.retentionDays);
const outboundClient = outboundClientFor(process.env, {
  accountSid: config.twilioAccountSid,
  authToken: config.twilioAuthToken,
});
if (outboundClient) logWarn("outbound is enabled; dials still need an approval card and code");
const app = createApp(outboundClient ? { config, store, outboundClient } : { config, store });

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("shutting down");
  app.wss.close();
  app.server.close(() => {
    void app.drain().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 25_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (err: unknown) => {
  const name = err instanceof Error ? err.name : "rejection";
  logError(`unhandled rejection name=${name}`);
});

app.server.listen(config.port, config.host, () => {
  logInfo(
    `listening port=${config.port} voice=${config.xaiVoice} pronunciation=${config.pronunciationReplace} summaryWebhook=${config.summaryWebhookUrl ? "set" : "unset"} summaryAuth=${config.summaryWebhookAuth ? "set" : "unset"} xai=${config.xaiApiKey ? "configured" : "missing"}`,
  );
});
