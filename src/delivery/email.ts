import { AMOUNT_TOKEN, LINK_TOKEN } from "../recovery/composer.ts";
import { config } from "../config.ts";

// The composer writes an SMS: under 300 chars, link inline, no structure. Sent
// as email verbatim it read as phishing — unfamiliar address, "your payment
// failed", a bare shortened URL, nothing else.
//
// The fix wasn't rewriting the words, it was not treating two media as one. The
// composer already leaves {{amount}} and {{link}} for code to substitute, so
// each medium can decide what a fact looks like: SMS has only a URL to offer,
// email has a button.

export interface EmailContent {
  /** The composed body with `{{amount}}` and `{{link}}` still unsubstituted. */
  template: string;
  amount: string;
  link: string;
  /** The failed payment's id, shown so the recipient can tie this to a real attempt. */
  reference: string;
}

export interface RenderedEmail {
  text: string;
  html: string;
}

export function renderEmail(content: EmailContent): RenderedEmail {
  return { text: renderText(content), html: renderHtml(content) };
}

// Not a formality — HTML with no text part is a spam signal, and some clients
// show only this one.
function renderText(content: EmailContent): string {
  const body = substitute(content.template, content.amount, content.link);
  return [
    body,
    "",
    `Amount: ${content.amount}`,
    `Reference: ${content.reference}`,
    "",
    whyThisArrived(),
    `Sent by ${config.merchantName}.`,
  ].join("\n");
}

function renderHtml(content: EmailContent): string {
  // Model-written prose, escaped before any markup goes near it. Placeholders
  // survive escaping since braces aren't escaped.
  const prose = substitute(
    escapeHtml(content.template),
    `<strong style="color:#18181b;">${escapeHtml(content.amount)}</strong>`,
    `<a href="${escapeAttribute(content.link)}" style="color:#1d4ed8;">this link</a>`,
  );

  const merchant = escapeHtml(config.merchantName);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Email clients invert colours for dark mode with no regard for contrast.
     Declaring a scheme keeps the card readable instead of leaving it to them. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<!-- Clients strip the head entirely; the subject is the real title. Kept
     only so the document is well formed. -->
<title>${merchant}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<!-- Tables rather than flexbox: Outlook renders on Word's engine and does not
     support modern layout. This is the shape every transactional email has. -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;border-collapse:collapse;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">

  <tr><td style="padding:20px 32px;border-bottom:1px solid #f4f4f5;">
    <span style="font-size:15px;font-weight:600;color:#18181b;letter-spacing:-0.01em;">${merchant}</span>
  </td></tr>

  <tr><td style="padding:32px;">
    <!-- Not a restatement of the subject. This line used to be the subject
         verbatim, which meant opening the email bought the reader nothing. The
         subject says what happened; this says what can be done about it; the
         prose says why; the button does it. Each line earns its place. -->
    <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;font-weight:600;color:#18181b;letter-spacing:-0.01em;">
      You can still complete it
    </h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46;">${prose}</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr><td style="border-radius:8px;background:#18181b;">
        <a href="${escapeAttribute(content.link)}"
           style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
          Complete payment &mdash; ${escapeHtml(content.amount)}
        </a>
      </td></tr>
    </table>

    <p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #f4f4f5;font-size:13px;line-height:1.6;color:#71717a;">
      Amount: ${escapeHtml(content.amount)}<br>
      Reference: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(content.reference)}</span>
    </p>
  </td></tr>

  <tr><td style="padding:18px 32px;background:#fafafa;border-top:1px solid #f4f4f5;border-radius:0 0 12px 12px;">
    <p style="margin:0;font-size:12px;line-height:1.6;color:#71717a;">
      ${escapeHtml(whyThisArrived())}<br>
      Sent by ${merchant}.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// A recovery email is unsolicited by definition. Saying no money was taken
// removes the reason a confused recipient would report it.
function whyThisArrived(): string {
  // No amount — it's already stated twice above.
  return `You're receiving this because a payment to ${config.merchantName} didn't complete. ` +
    "If that wasn't you, no payment has been taken and you can ignore this.";
}

function substitute(text: string, amount: string, link: string): string {
  return text.split(AMOUNT_TOKEN).join(amount).split(LINK_TOKEN).join(link);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
