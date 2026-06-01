import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'mail.example.com',
  port: parseInt(process.env.SMTP_PORT ?? '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER ?? 'noreply@example.com',
    pass: process.env.SMTP_PASS ?? 'Ezfun.us1228',
  },
})

const FROM = process.env.SMTP_FROM ?? 'noreply@example.com'

export async function sendMagicLink(
  to: string,
  code: string,
  magicToken: string,
): Promise<void> {
  const baseUrl = process.env.APP_URL ?? 'https://gw.example.com'
  const link = `${baseUrl}/api/auth/callback?token=${magicToken}`

  await transporter.sendMail({
    from: `"2Coding Gateway" <${FROM}>`,
    to,
    subject: `Your verification code / 您的验证码: ${code}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <h2 style="font-size:20px;font-weight:600;margin:0 0 24px;">2Coding Gateway</h2>
        <div style="background:#f3f4f6;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;">
          <span style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace;">${code}</span>
        </div>
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">
          您的验证码如上所示。您也可以点击下方按钮直接登录。
        </p>
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">
          Your verification code is shown above. You can also click the button below to sign in directly.
        </p>
        <div style="text-align:center;margin:0 0 24px;">
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;font-size:15px;font-weight:500;padding:12px 32px;border-radius:10px;text-decoration:none;">
            登录 / Sign In
          </a>
        </div>
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0;">
          此验证码将在 5 分钟后过期。如果您没有请求此验证码，请忽略此邮件。
        </p>
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:4px 0 0;">
          This code expires in 5 minutes. If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  })
}
