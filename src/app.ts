import express, { Express, NextFunction, Request, Response } from "express";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import contentRouter from "./routes/content";

const NODE_ENV = process.env.NODE_ENV;
const app: Express = express();

// Type declaration for morgan options
const morganOption: string = NODE_ENV === "production" ? "tiny" : "common";

// Middleware
app.use(morgan(morganOption));
app.use(cors());
app.use(helmet());

// Routes
app.get("/", (req: Request, res: Response) => {
  res.send("💓1.0.0");
});

app.use("/api", contentRouter);

// Catch uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1); // Exit the process with a non-zero status code
});

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
  console.error("Unhandled Rejection:", reason);
});

// Error handling middleware
app.use(function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (res.headersSent) {
    return next(err);
  }
  const customErr = err as { status?: number; message?: string };
  const status = customErr.status || 500;
  const message = customErr.message || "Internal Server Error";
  res.status(status).json({ error: message });
});

export default app;
