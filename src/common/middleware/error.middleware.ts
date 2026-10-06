import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import multer from "multer";
import { AppError } from "../errors/AppError";
import { isDevelopment, isTest } from "../../config/env";
import { deleteUploadedFiles } from "../utils/file-cleanup";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceRef?: string;
  };
}

const send = (
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
): void => {
  const body: ErrorBody = { error: { code, message, traceRef: req.traceRef } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
};

// Remove files that multer already wrote to disk when the request ultimately failed.
const discardUploadedFiles = async (req: Request): Promise<void> => {
  const files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  if (files.length === 0) return;
  await deleteUploadedFiles(files.map((file) => `/uploads/${req.uploadFolder ?? ""}/${file.filename}`)).catch(
    () => undefined
  );
};

export const notFoundHandler = (req: Request, res: Response): void => {
  send(req, res, 404, "ROUTE_NOT_FOUND", "Route not found");
};

export const errorHandler = (error: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  void discardUploadedFiles(req);

  if (error instanceof AppError) {
    send(req, res, error.statusCode, error.code, error.message, error.details);
    return;
  }

  if (error instanceof ZodError) {
    send(
      req,
      res,
      400,
      "VALIDATION_ERROR",
      "Request validation failed",
      error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }))
    );
    return;
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      send(req, res, 413, "FILE_TOO_LARGE", "Uploaded file exceeds the maximum allowed size");
    } else if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
      send(req, res, 400, "UPLOAD_LIMIT_EXCEEDED", "Too many files or unexpected file field");
    } else {
      send(req, res, 400, "UPLOAD_ERROR", "Invalid upload request");
    }
    return;
  }

  if (error instanceof mongoose.Error.CastError) {
    send(req, res, 400, "INVALID_IDENTIFIER", "Malformed identifier");
    return;
  }

  // body-parser errors (malformed JSON, payload too large)
  const parserError = error as { type?: string; status?: number };
  if (parserError?.type === "entity.parse.failed") {
    send(req, res, 400, "INVALID_JSON", "Request body is not valid JSON");
    return;
  }
  if (parserError?.type === "entity.too.large") {
    send(req, res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    return;
  }

  // MongoDB duplicate key that slipped past an application-level check
  if ((error as { code?: number })?.code === 11000) {
    send(req, res, 409, "DUPLICATE_RESOURCE", "Resource already exists");
    return;
  }

  // Unknown error: log everything server-side, expose nothing to the client.
  if (!isTest) {
    console.error(`[${req.traceRef}] Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  }
  const detail = isDevelopment && error instanceof Error ? { stack: error.stack } : undefined;
  send(req, res, 500, "INTERNAL_SERVER_ERROR", "Internal server error", detail);
};
