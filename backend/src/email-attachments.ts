import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { config } from "./config.js";

const maxFileSize = config.EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024;
const maxTotalSize = config.EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024;
const storageDirectory = path.resolve(config.EMAIL_ATTACHMENT_STORAGE_DIR);

const allowedTypes = {
  ".pdf": { contentType: "application/pdf", mimeTypes: ["application/pdf", "application/octet-stream"] },
  ".doc": { contentType: "application/msword", mimeTypes: ["application/msword", "application/octet-stream"] },
  ".docx": { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream", "application/zip"] },
  ".png": { contentType: "image/png", mimeTypes: ["image/png"] },
  ".jpg": { contentType: "image/jpeg", mimeTypes: ["image/jpeg"] },
  ".jpeg": { contentType: "image/jpeg", mimeTypes: ["image/jpeg"] },
  ".gif": { contentType: "image/gif", mimeTypes: ["image/gif"] },
  ".webp": { contentType: "image/webp", mimeTypes: ["image/webp"] },
  ".svg": { contentType: "image/svg+xml", mimeTypes: ["image/svg+xml", "text/xml", "application/xml", "text/plain"] },
  ".txt": { contentType: "text/plain", mimeTypes: ["text/plain", "application/octet-stream"] },
  ".csv": { contentType: "text/csv", mimeTypes: ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"] },
  ".xls": { contentType: "application/vnd.ms-excel", mimeTypes: ["application/vnd.ms-excel", "application/octet-stream"] },
  ".xlsx": { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream", "application/zip"] }
} as const;

const attachmentMetadataSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255).refine((value) => !/[/\\\u0000-\u001f\u007f]/.test(value)),
  contentType: z.string().max(127).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  size: z.number().int().positive().max(maxFileSize)
}).strict();

const legacyAttachmentSchema = attachmentMetadataSchema.extend({
  content: z.string().max(Math.ceil(maxFileSize / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
}).strict().refine(({ content, size }) => {
  const buffer = Buffer.from(content, "base64");
  return buffer.length === size && buffer.toString("base64") === content;
}, "Attachment content size does not match");

export const emailAttachmentsSchema = z.array(z.union([attachmentMetadataSchema, legacyAttachmentSchema])).max(5)
  .refine((attachments) => attachments.reduce((total, attachment) => total + attachment.size, 0) <= maxTotalSize, `Attachments must total ${config.EMAIL_ATTACHMENT_MAX_TOTAL_SIZE_MB} MB or less`);

export type EmailAttachment = z.infer<typeof attachmentMetadataSchema>;
export interface UploadedAttachment {
  metadata: EmailAttachment;
  content: Buffer;
}

export function isAllowedAttachmentName(filename: string): boolean {
  return Object.hasOwn(allowedTypes, path.extname(filename).toLowerCase());
}

export function attachmentFromUpload(file: Express.Multer.File): UploadedAttachment {
  const filename = path.basename(file.originalname.replace(/\\/g, "/"));
  const extension = path.extname(filename).toLowerCase() as keyof typeof allowedTypes;
  const type = allowedTypes[extension];
  if (!type || !type.mimeTypes.some((mimeType) => mimeType === file.mimetype)) {
    throw new Error(`Unsupported file type: ${filename}`);
  }
  if (file.size === 0 || file.size > maxFileSize) {
    throw new Error(`${filename} must be between 1 byte and ${config.EMAIL_ATTACHMENT_MAX_FILE_SIZE_MB} MB.`);
  }

  const content = validateAndNormalizeContent(extension, file.buffer, filename);
  return {
    metadata: {
      id: randomUUID(),
      filename,
      contentType: type.contentType,
      size: content.length
    },
    content
  };
}

function validateAndNormalizeContent(extension: keyof typeof allowedTypes, bytes: Buffer, filename: string): Buffer {
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`${filename} is not a valid PDF file.`);
  }
  if (extension === ".png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${filename} is not a valid PNG image.`);
  }
  if ((extension === ".jpg" || extension === ".jpeg") && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error(`${filename} is not a valid JPEG image.`);
  }
  if (extension === ".gif" && !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    throw new Error(`${filename} is not a valid GIF image.`);
  }
  if (extension === ".webp" && !(bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")) {
    throw new Error(`${filename} is not a valid WebP image.`);
  }
  if (extension === ".doc" || extension === ".xls") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new Error(`${filename} is not a valid Office document.`);
    }
  }
  if (extension === ".docx" || extension === ".xlsx") {
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1))) {
      throw new Error(`${filename} is not a valid Office document.`);
    }
    const requiredEntry = extension === ".docx" ? "word/document.xml" : "xl/workbook.xml";
    if (!isOfficeOpenXmlArchive(bytes, requiredEntry)) {
      throw new Error(`${filename} is not a valid ${extension.slice(1).toUpperCase()} document.`);
    }
  }
  if (extension === ".txt" || extension === ".csv") {
    assertUtf8Text(bytes, filename);
  }
  if (extension === ".svg") {
    const source = decodeUtf8Text(bytes, filename);
    if (!/<svg(?:\s|>)/i.test(source)) throw new Error(`${filename} is not a valid SVG image.`);
    const sanitized = sanitizeHtml(source, {
      allowedTags: ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc"],
      allowedAttributes: {
        "*": ["id", "class", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "viewBox", "d", "points", "fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "transform", "offset", "stop-color", "stop-opacity", "xmlns", "preserveAspectRatio"]
      },
      allowedSchemes: [],
      allowProtocolRelative: false
    });
    if (!/<svg(?:\s|>)/i.test(sanitized)) throw new Error(`${filename} does not contain a safe SVG image.`);
    return Buffer.from(sanitized, "utf8");
  }
  return bytes;
}

function decodeUtf8Text(bytes: Buffer, filename: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.includes(0)) throw new Error();
    return text;
  } catch {
    throw new Error(`${filename} must contain valid UTF-8 text.`);
  }
}

function assertUtf8Text(bytes: Buffer, filename: string): void {
  decodeUtf8Text(bytes, filename);
}

function isOfficeOpenXmlArchive(bytes: Buffer, requiredEntry: string): boolean {
  const endOfCentralDirectory = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const searchStart = Math.max(0, bytes.length - 65_557);
  const endOffset = bytes.lastIndexOf(endOfCentralDirectory);
  if (endOffset < searchStart || endOffset + 22 > bytes.length) return false;
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);
  let offset = centralDirectoryOffset;
  let hasContentTypes = false;
  let hasRequiredEntry = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) return false;
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (name === requiredEntry) hasRequiredEntry = true;
    offset = end;
  }
  return hasContentTypes && hasRequiredEntry;
}

function getStoragePath(id: string): string {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Attachment reference is invalid");
  return path.join(storageDirectory, `${id}.enc`);
}

function encryptFile(content: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptFile(encrypted: Buffer): Buffer {
  if (encrypted.length < 28) throw new Error("Stored email attachment is malformed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"),
    encrypted.subarray(0, 12)
  );
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
}

export async function persistAttachment(upload: UploadedAttachment): Promise<void> {
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await chmod(storageDirectory, 0o700);
  await writeFile(getStoragePath(upload.metadata.id), encryptFile(upload.content), { flag: "wx", mode: 0o600 });
}

export async function readPersistedAttachment(id: string): Promise<Buffer> {
  return decryptFile(await readFile(getStoragePath(id)));
}

export async function removePersistedAttachment(id: string): Promise<void> {
  try {
    await rm(getStoragePath(id));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function encryptAttachmentData(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("base64")}`;
}

export function decryptAttachmentData(value: string): string {
  const [ivHex, tagHex, contentHex] = value.split(".");
  if (!ivHex || !tagHex || !contentHex) throw new Error("Stored email attachment data is malformed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(contentHex, "base64")),
    decipher.final()
  ]).toString("utf8");
}
