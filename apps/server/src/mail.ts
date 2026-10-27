import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Development and tests: keeps mail in memory (and logs it) instead of sending it. */
export class OutboxMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(private readonly log?: (line: string) => void) {}
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    this.log?.(`[mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** A plain, branded email with one call to action. */
export function actionMail(
  to: string,
  subject: string,
  intro: string,
  action: string,
  url: string,
): Mail {
  return {
    to,
    subject,
    text: `${intro}\n\n${action}: ${url}\n\nIf you didn't expect this, you can ignore it.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
<p style="font-weight:800;font-size:20px;letter-spacing:-0.04em;margin:0 0 24px">kovan</p>
<p style="font-size:15px;line-height:1.6">${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">${escapeHtml(action)}</a></p>
<p style="font-size:12px;color:#71717a">If you didn't expect this, you can ignore it.</p></div>`,
  };
}
