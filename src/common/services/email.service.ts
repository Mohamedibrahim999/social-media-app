import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import nodemailer, { Transporter } from "nodemailer";
import { env } from "../../config/env";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** In-memory outbox used only when EMAIL_TRANSPORT=memory (automated tests). */
export const memoryOutbox: OutgoingMail[] = [];

let smtpTransporter: Transporter | null = null;
const getSmtpTransporter = (): Transporter => {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
    });
  }
  return smtpTransporter;
};

const deliver = async (mail: OutgoingMail): Promise<void> => {
  switch (env.EMAIL_TRANSPORT) {
    case "smtp":
      await getSmtpTransporter().sendMail({ from: env.EMAIL_USER, ...mail });
      return;
    case "file": {
      // Local development only: the message lands in .mail-outbox/ (git-ignored), never in logs or API responses.
      const directory = path.join(process.cwd(), ".mail-outbox");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ ...mail, sentAt: new Date().toISOString() }, null, 2)
      );
      return;
    }
    case "memory":
      memoryOutbox.push(mail);
      return;
  }
};

export const sendVerificationCode = async (email: string, code: string): Promise<void> => {
  await deliver({
    to: email,
    subject: "Your login verification code",
    text: `Your verification code is: ${code}. It expires in 10 minutes and can be used only once.`,
  });
};
