// Hono HTTP server. Two routes:
//   POST /webhook  — GitHub workflow_job receiver, HMAC-verified
//   GET  /healthz  — liveness check (returns 200 if vault token + docker are reachable)

import { verify } from "@octokit/webhooks-methods";
import type { WorkflowJobEvent } from "@octokit/webhooks-types";
import { Hono } from "hono";
import { log } from "./log.js";
import type { WebhookContext } from "./webhook.js";
import { handleWorkflowJob } from "./webhook.js";

export interface ServerDeps {
  webhookSecret: string;
  ctx: WebhookContext;
}

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    try {
      await deps.ctx.docker.ping();
      return c.json({ status: "ok" });
    } catch (err) {
      log.error({ err }, "healthz: docker ping failed");
      return c.json({ status: "degraded", error: String(err) }, 503);
    }
  });

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const deliveryId = c.req.header("x-github-delivery");

    if (!signature) {
      log.warn({ delivery_id: deliveryId }, "webhook missing signature");
      return c.json({ error: "missing signature" }, 401);
    }

    const rawBody = await c.req.text();
    const valid = await verify(deps.webhookSecret, rawBody, signature);
    if (!valid) {
      log.warn({ delivery_id: deliveryId }, "webhook signature invalid");
      return c.json({ error: "invalid signature" }, 401);
    }

    if (event !== "workflow_job") {
      log.debug({ event, delivery_id: deliveryId }, "ignoring non-workflow_job event");
      return c.json({ status: "ignored", reason: `event=${event}` });
    }

    let payload: WorkflowJobEvent;
    try {
      payload = JSON.parse(rawBody) as WorkflowJobEvent;
    } catch (err) {
      log.error({ err, delivery_id: deliveryId }, "webhook body not JSON");
      return c.json({ error: "invalid json" }, 400);
    }

    try {
      const result = await handleWorkflowJob(deps.ctx, payload);
      log.info(
        {
          delivery_id: deliveryId,
          job_id: payload.workflow_job.id,
          action: payload.action,
          result,
        },
        "webhook handled",
      );
      return c.json({ status: "ok", result });
    } catch (err) {
      log.error({ err, delivery_id: deliveryId, job_id: payload.workflow_job.id }, "webhook handler threw");
      return c.json({ error: "handler error" }, 500);
    }
  });

  return app;
}
