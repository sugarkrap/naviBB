import {
  createTransport,
  Transporter,
} from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface MailService {
  transporter: Transporter<SMTPTransport.SentMessageInfo>;
  verifySmtpConnection(): Promise<void>;
  sendActivationEmail(to: string, token: string, baseUrl: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string, baseUrl: string): Promise<void>;
}

export function createMailTransporter(
  config: MailConfig,
): Transporter<SMTPTransport.SentMessageInfo> {
  const auth =
    config.user && config.pass
      ? {
          user: config.user,
          pass: config.pass,
        }
      : undefined;

  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth,
  });
}

export function createMailService(
  config: MailConfig,
  transporter: Transporter<SMTPTransport.SentMessageInfo>,
): MailService {
  return {
    transporter,

    async verifySmtpConnection(): Promise<void> {
      await transporter.verify();
    },

    async sendActivationEmail(
      to: string,
      token: string,
      baseUrl: string,
    ): Promise<void> {
      const activationUrl = new URL(
        `/activate/${encodeURIComponent(token)}`,
        baseUrl,
      ).toString();

      await transporter.sendMail({
        from: config.from,
        to,
        subject: 'Activate your naviBB account',
        text: `Welcome to naviBB!\n\nActivate your account by opening this link:\n${activationUrl}\n\nIf you did not create this account, you can ignore this email.`,
        html: `<p>Welcome to naviBB!</p><p><a href="${activationUrl}">Activate your account</a></p><p>If you did not create this account, you can ignore this email.</p>`,
      });
    },

    async sendPasswordResetEmail(
      to: string,
      token: string,
      baseUrl: string,
    ): Promise<void> {
      const resetUrl = new URL(
        `/reset-password/${encodeURIComponent(token)}`,
        baseUrl,
      ).toString();

      await transporter.sendMail({
        from: config.from,
        to,
        subject: 'Reset your naviBB password',
        text: `Hello!\n\nReset your naviBB password by opening this link (valid for 1 hour):\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`,
        html: `<p>Hello!</p><p><a href="${resetUrl}">Reset your password</a> (valid for 1 hour)</p><p>If you did not request a password reset, you can ignore this email.</p>`,
      });
    },
  };
}
