import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "./email.ts";
import { subjectFor } from "./channel.ts";
import { AMOUNT_TOKEN, LINK_TOKEN } from "../recovery/composer.ts";

/**
 * The email renderer takes model-written prose and puts it inside markup, which
 * is the one place in this system where untrusted text meets a document that
 * gets interpreted. These tests hold that boundary, and hold the properties that
 * separate a transactional email from something a spam filter will bin.
 */

const content = {
  template: `Hi — your ${AMOUNT_TOKEN} payment didn't go through. You can try again here: ${LINK_TOKEN}`,
  amount: "₹2,499",
  link: "https://rzp.io/i/abc123",
  reference: "pay_TTx91kLm0QQ2ab",
};

test("no placeholder survives into anything that gets sent", () => {
  // A leaked "{{link}}" is a message with no way to pay in it, sent to a real
  // person. Worth a test in both parts rather than trusting one substitution.
  const { text, html } = renderEmail(content);
  for (const [part, rendered] of [["text", text], ["html", html]] as const) {
    assert.ok(!rendered.includes(AMOUNT_TOKEN), `amount placeholder left in ${part}`);
    assert.ok(!rendered.includes(LINK_TOKEN), `link placeholder left in ${part}`);
  }
});

test("the link is a real destination in both parts", () => {
  const { text, html } = renderEmail(content);
  assert.ok(text.includes(content.link));
  assert.ok(html.includes(`href="${content.link}"`));
});

test("model-written prose cannot inject markup", () => {
  // The prose comes from a language model. It is not hostile, but it is not
  // ours either, and it is being placed inside a document that gets parsed.
  const { html } = renderEmail({
    ...content,
    template: `<script>alert(1)</script> pay ${AMOUNT_TOKEN} here: ${LINK_TOKEN}`,
  });
  assert.ok(!html.includes("<script>"), "prose was interpolated unescaped");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the plain-text part carries no markup", () => {
  // Some clients render only this one, and a message full of raw tags in those
  // clients looks worse than the bare message it replaced.
  const { text } = renderEmail(content);
  assert.ok(!/<[a-z]/i.test(text), `text part contains markup: ${text}`);
});

test("the amount and the reference are stated, not left to the prose", () => {
  // Both are facts. Facts in this system are assembled by code, and a recipient
  // needs the reference to tie an unexpected email to a payment they made.
  const { text, html } = renderEmail(content);
  for (const rendered of [text, html]) {
    assert.ok(rendered.includes(content.amount));
    assert.ok(rendered.includes(content.reference));
  }
});

test("both parts say why the email arrived and that no money was taken", () => {
  // A recovery email is unsolicited by definition. A confused recipient who is
  // told nothing has been charged ignores it; one who is told nothing reports it.
  const { text, html } = renderEmail(content);
  for (const rendered of [text, html]) {
    assert.match(rendered, /receiving this because/i);
    assert.match(rendered, /no payment has been taken/i);
  }
});

test("nothing in the rendering applies pressure", () => {
  const { text, html } = renderEmail(content);
  for (const rendered of [text, html]) {
    assert.ok(!/urgent|hurry|last chance|act now|expires soon/i.test(rendered));
  }
});

test("the heading does not restate the subject", () => {
  // It did, word for word, which meant the most valuable line in the message
  // told the reader something they had already read in the inbox list.
  const { html } = renderEmail(content);
  assert.ok(
    !html.includes(subjectFor(content.amount)),
    "the subject line is repeated verbatim inside the email",
  );
});

test("the amount is stated a few times, not at every level", () => {
  // Subject, heading, prose, button, amount line and footer all carried it at
  // one point. A figure repeated six times stops reading as information.
  const { html } = renderEmail(content);
  const occurrences = html.split(content.amount).length - 1;
  assert.ok(occurrences <= 3, `amount appears ${occurrences} times in the email`);
});
