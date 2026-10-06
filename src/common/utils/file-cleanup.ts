import fs from "fs/promises";
import path from "path";

const uploadsDirectory = path.join(
  process.cwd(),
  "uploads"
);

const PROTECTED_PREFIX = "/uploads/defaults/";
export const deleteUploadedFile = async (
  filePath: string | null | undefined
) => {
  if (!filePath || filePath.startsWith(PROTECTED_PREFIX)) {
    return; // never delete the shipped default pictures
  }

  const normalizedPath = filePath
    .replace(/^[/\\]+/, "")
    .replace(/\//g, path.sep);

  const absolutePath = path.resolve(
    process.cwd(),
    normalizedPath
  );

  const uploadsRoot = path.resolve(
    uploadsDirectory
  );

  if (
    absolutePath !== uploadsRoot &&
    !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)
  ) {
    return;
  }

  try {
    await fs.unlink(absolutePath);
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== "ENOENT") {
      throw error;
    }
  }
};

export const deleteUploadedFiles = async (
  filePaths: string[]
) => {
  for (const filePath of filePaths) {
    await deleteUploadedFile(filePath);
  }
};
