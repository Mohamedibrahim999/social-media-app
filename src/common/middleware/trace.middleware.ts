import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export const TRACE_HEADER = "X-Tapi-Trace-Ref";

// Only accept sane client values: an arbitrary header value could otherwise
// be used for log injection, or make res.setHeader() throw (-> 500).
const SAFE_TRACE_REF = /^[A-Za-z0-9._:\-/]{1,128}$/;

declare global {
  namespace Express {
    interface Request {
      traceRef: string;
    }
  }
}

export const traceMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.get(TRACE_HEADER);
  const traceRef = incoming && SAFE_TRACE_REF.test(incoming) ? incoming : randomUUID();
  req.traceRef = traceRef;
  res.setHeader(TRACE_HEADER, traceRef);
  next();
};
