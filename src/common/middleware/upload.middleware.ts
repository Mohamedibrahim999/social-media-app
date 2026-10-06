import multer from "multer";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { randomUUID } from "crypto";
import express, { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { AppError } from "../errors/AppError";
import { deleteUploadedFiles } from "../utils/file-cleanup";

export const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
export const DEFAULTS_ROOT = path.join(process.cwd(), "assets", "defaults");
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
export const MAX_POST_IMAGES = 10;

type UploadFolder = "profiles" | "pages" | "posts";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * The file CONTENT decides the type. The client-supplied extension and
 * Content-Type header are ignored (a `.png` that starts with `<?php` is rejected).
 */
export const detectImageType = async (filePath: string): Promise<{ extension: string; mimeType: string } | null> => {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    if (bytesRead < 12) return null;

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: ".jpg", mimeType: "image/jpeg" };
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { extension: ".png", mimeType: "image/png" };
    }
    const head6 = buffer.toString("ascii", 0, 6);
    if (head6 === "GIF87a" || head6 === "GIF89a") return { extension: ".gif", mimeType: "image/gif" };
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      return { extension: ".webp", mimeType: "image/webp" };
    }
    // BMP: "BM" + 4-byte size + 4 reserved zero bytes
    if (buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.readUInt32LE(6) === 0) {
      return { extension: ".bmp", mimeType: "image/bmp" };
    }
    return null;
  } finally {
    await handle.close();
  }
};

const uploadedFiles = (req: Request): Express.Multer.File[] => {
  const files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  return files;
};

const storageFor = (folder: UploadFolder) =>
  multer.diskStorage({
    destination: (_req, _file, callback) => {
      const directory = path.join(UPLOAD_ROOT, folder);
      fs.mkdirSync(directory, { recursive: true });
      callback(null, directory);
    },
    // Unguessable server-chosen name; the real extension is applied after signature detection.
    filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
  });

const validateSignatures: RequestHandler = async (req, _res, next) => {
  const files = uploadedFiles(req);
  try {
    for (const file of files) {
      const type = await detectImageType(file.path);
      if (!type) {
        throw new AppError("Unsupported or corrupted image. Allowed: JPEG, PNG, GIF, WebP, BMP", 415, "INVALID_IMAGE_TYPE");
      }
      const finalName = file.filename.replace(/\.upload$/, type.extension);
      await fsPromises.rename(file.path, path.join(path.dirname(file.path), finalName));
      file.filename = finalName;
      file.path = path.join(path.dirname(file.path), finalName);
      file.mimetype = type.mimeType;
    }
    next();
  } catch (error) {
    // nothing from a rejected request may stay on disk (the error handler also sweeps req.file(s))
    await Promise.all(files.map((file) => fsPromises.unlink(file.path).catch(() => undefined)));
    req.file = undefined;
    req.files = undefined;
    next(error);
  }
};

const build = (folder: UploadFolder, mode: "single" | "multiple"): RequestHandler[] => {
  const instance = multer({
    storage: storageFor(folder),
    limits: { fileSize: MAX_IMAGE_BYTES, files: mode === "single" ? 1 : MAX_POST_IMAGES },
    fileFilter: (_req, file, callback) => {
      // First, cheap gate only. The authoritative check is the magic-byte test above.
      if (!file.mimetype.startsWith("image/")) {
        callback(new AppError("Only image uploads are allowed", 415, "INVALID_IMAGE_TYPE"));
        return;
      }
      callback(null, true);
    },
  });
  const setFolder: RequestHandler = (req, _res, next) => {
    req.uploadFolder = folder;
    next();
  };
  const parse = mode === "single" ? instance.single("image") : instance.array("images", MAX_POST_IMAGES);
  return [setFolder, parse, validateSignatures];
};

export const profilePictureUpload = build("profiles", "single");
export const pagePictureUpload = build("pages", "single");
export const postImagesUpload = build("posts", "multiple");

/** Public file serving: no auth, correct Content-Type, long-lived cache, nosniff. */
export const createUploadsRouter = (): Router => {
  const router = Router();

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const extension = path.extname(req.path).toLowerCase();
    if (!MIME_BY_EXTENSION[extension]) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "File not found", traceRef: req.traceRef } });
      return;
    }
    next();
  };

  const staticOptions = (maxAge: string, immutable: boolean) => ({
    dotfiles: "deny" as const,
    index: false,
    redirect: false,
    maxAge,
    immutable,
    setHeaders: (res: Response, filePath: string) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  });

  router.use("/defaults", guard, express.static(DEFAULTS_ROOT, staticOptions("1d", false)));
  router.use(guard, express.static(UPLOAD_ROOT, staticOptions("365d", true))); // names are random UUIDs => safe to cache forever
  return router;
};

export { deleteUploadedFiles };
