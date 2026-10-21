import nodemailer, { type Transporter } from 'nodemailer';
import type { DataSource } from 'typeorm';
import { effectiveMailServer, type MailServer } from './mail-settings.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type Sender = (mail: OutgoingMail) => Promise<void>;
type Logger = { error: (obj: unknown, msg: string) => void };

let cached: { signature: string; transporter: Transporter } | null = null;
let override: Sender | null = null;

/** Tests swap the transport. Pass null to restore SMTP. */
export function setMailSender(sender: Sender | null): void {
  override = sender;
}

export async function mailConfigured(db: DataSource | undefined): Promise<boolean> {
  return override !== null || (await effectiveMailServer(db)) !== null;
}

function transporterFor(server: MailServer): Transporter {
  const signature = JSON.stringify(server);
  if (cached?.signature === signature) return cached.transporter;
  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: server.user ? { user: server.user, pass: server.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { signature, transporter };
  return transporter;
}

/** Sends one message. Throws on failure so the settings page can show the reason. */
export async function sendMailOrThrow(db: DataSource | undefined, mail: OutgoingMail): Promise<boolean> {
  if (override) {
    await override(mail);
    return true;
  }
  const server = await effectiveMailServer(db);
  if (!server) return false;
  await transporterFor(server).sendMail({ from: server.from, ...mail });
  return true;
}

/** True when the server accepted the message. False when mail is not configured or the send failed. */
export async function sendMail(db: DataSource | undefined, mail: OutgoingMail, log?: Logger): Promise<boolean> {
  try {
    return await sendMailOrThrow(db, mail);
  } catch (err) {
    log?.error(err, 'Failed to send email');
    return false;
  }
}

export function testMail(to: string): OutgoingMail {
  return {
    to,
    subject: 'DepGate test email',
    text: 'This is a test message from DepGate. Your mail settings work.',
    html: '<p style="font-family:Arial,sans-serif">This is a test message from DepGate. Your mail settings work.</p>',
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(heading: string, body: string, url: string, button: string, footer: string): { text: string; html: string } {
  return {
    text: `${heading}\n\n${body}\n\n${url}\n\n${footer}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
<p style="line-height:1.5">${escapeHtml(body)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#6366f1;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(button)}</a></p>
<p style="font-size:12px;color:#64748b;line-height:1.5">If the button does not work, paste this link into your browser:<br>${escapeHtml(url)}</p>
<p style="font-size:12px;color:#64748b">${escapeHtml(footer)}</p></div>`,
  };
}

export function inviteMail(to: string, url: string, role: string, expiryHours: number): OutgoingMail {
  const days = expiryHours % 24 === 0 ? `${expiryHours / 24} days` : `${expiryHours} hours`;
  return {
    to,
    subject: 'You have been invited to DepGate',
    ...layout(
      'Set up your DepGate account',
      `You have been added to DepGate as ${role}. Choose a password to finish setting up your account.`,
      url,
      'Set your password',
      `This link works once and expires in ${days}. If you did not expect this email, ignore it.`
    ),
  };
}

export function resetMail(to: string, url: string, expiryMinutes: number): OutgoingMail {
  return {
    to,
    subject: 'Reset your DepGate password',
    ...layout(
      'Reset your password',
      'We received a request to reset the password for your DepGate account.',
      url,
      'Choose a new password',
      `This link works once and expires in ${expiryMinutes} minutes. If you did not ask for this, ignore it; your password has not changed.`
    ),
  };
}
