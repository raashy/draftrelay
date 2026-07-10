import { Resend } from "resend";

import type { CloudConfig } from "./config.js";

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createEmailSender(config: CloudConfig): (email: TransactionalEmail) => Promise<void> {
  if (!config.email) {
    return async () => {
      if (config.environment === "production") {
        throw new Error("Transactional email is not configured");
      }
    };
  }

  const resend = new Resend(config.email.apiKey);
  return async (email) => {
    const result = await resend.emails.send({
      from: config.email!.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html
    });
    if (result.error) throw new Error(`Email delivery failed: ${result.error.message}`);
  };
}

export function verificationEmail(appName: string, email: string, url: string): TransactionalEmail {
  const safeUrl = escapeHtml(url);
  return {
    to: email,
    subject: `Verify your ${appName} email`,
    text: `Verify your email to finish setting up ${appName}: ${url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Verify your email to finish setting up ${escapeHtml(appName)}.</p><p><a href="${safeUrl}">Verify email</a></p><p>If you did not request this, you can ignore this email.</p>`
  };
}

export function resetPasswordEmail(appName: string, email: string, url: string): TransactionalEmail {
  const safeUrl = escapeHtml(url);
  return {
    to: email,
    subject: `Reset your ${appName} password`,
    text: `Reset your ${appName} password: ${url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Use this link to reset your ${escapeHtml(appName)} password.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
  };
}

export const emailInternals = { escapeHtml };
