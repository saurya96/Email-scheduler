import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config.js";
import { closeServices, redis } from "./services.js";
import { emailQueue } from "./queue.js";
import { requireAuth } from "./auth.js";
import routes from "./routes.js";

const app = express();
const sessionName = "reachinbox.sid";

app.disable("x-powered-by");
if (config.NODE_ENV === "production") app.set("trust proxy", 1);
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", config.CORS_ORIGIN);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "20mb" }));
app.use(session({
  name: sessionName,
  store: new RedisStore({ client: redis }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter
});
app.use("/admin/queues", requireAuth, serverAdapter.getRouter());
app.use(routes);

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "Request body contains invalid JSON" });
    return;
  }
  if (error instanceof Error && error.name === "ZodError") {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error("Request failed:", error);
  response.status(500).json({ error: "An unexpected server error occurred" });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  console.info(`API listening at ${config.API_URL}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await emailQueue.close();
  await closeServices();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
