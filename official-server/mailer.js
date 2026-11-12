import { createTransport } from 'nodemailer';

/**
 * Verification-mail sender. Generic SMTP via nodemailer; under NODE_ENV=test the
 * caller supplies an `outbox` array and every mail is captured there instead of
 * touching the network. Returns null when SMTP is not configured: registration
 * answers email_unavailable while login for existing accounts keeps working.
 */
export function createMailer({ host, port, secure, user, pass, from, outbox }) {
  if (!host || !user || !pass || !from) return null;
  const transport = outbox
    ? { sendMail: async mail => { outbox.push(mail); return { messageId: `test-${outbox.length}` }; } }
    : createTransport({
        host,
        port: Number(port) || 587,
        secure: String(secure).toLowerCase() === 'true',
        auth: { user, pass },
      });
  return {
    from,
    async sendVerificationCode(to, code, expiresInMinutes) {
      const info = await transport.sendMail({
        from,
        to,
        subject: 'MetaWork 注册验证码',
        text: `您的 MetaWork 验证码是 ${code}，${expiresInMinutes} 分钟内有效。请勿泄露给任何人。`,
      });
      return typeof info?.messageId === 'string' ? info.messageId : null;
    },
  };
}
