const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Maia <hello@maia.app>';

export const emailEnabled = !!RESEND_API_KEY;

// Without a mail key (local dev only; production refuses to boot without one), links are printed to the server log.
async function sendEmail(to, subject, html, kind, link) {
  if (!RESEND_API_KEY) {
    console.log(`[dev] ${kind} link for ${to}: ${link}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

// Each email in the language the person uses the app in.
const VERIFY = {
  en: ['Confirm your email for Maia', (link) => `<p>Welcome to Maia.</p><p><a href="${link}">Confirm your email</a> to start your ritual. This link expires in 24 hours.</p><p>If you didn't create an account, you can ignore this email.</p>`],
  tr: ['Maia için e-postanı onayla', (link) => `<p>Maia'ya hoş geldin.</p><p>Ritüeline başlamak için <a href="${link}">e-postanı onayla</a>. Bu bağlantı 24 saat geçerlidir.</p><p>Bu hesabı sen oluşturmadıysan bu e-postayı yok sayabilirsin.</p>`],
};
const RESET = {
  en: ['Reset your Maia password', (link) => `<p><a href="${link}">Choose a new password</a>. This link expires in 1 hour and signs you out everywhere once used.</p><p>If you didn't ask for this, you can ignore this email; your password stays the same.</p>`],
  tr: ['Maia şifreni yenile', (link) => `<p><a href="${link}">Yeni bir şifre seç</a>. Bu bağlantı 1 saat geçerlidir ve kullanıldığında tüm cihazlarda oturumun kapanır.</p><p>Bunu sen istemediysen bu e-postayı yok sayabilirsin; şifren aynı kalır.</p>`],
};

export const sendVerificationEmail = (email, link, lang) => {
  const [subject, body] = VERIFY[lang] || VERIFY.en;
  return sendEmail(email, subject, body(link), 'verify', link);
};

export const sendPasswordResetEmail = (email, link, lang) => {
  const [subject, body] = RESET[lang] || RESET.en;
  return sendEmail(email, subject, body(link), 'reset', link);
};
