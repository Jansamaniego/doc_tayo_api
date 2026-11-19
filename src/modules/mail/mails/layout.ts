import { html, type SafeHtml } from '@nestjs/mail';

/** Removes line breaks so a value can never split a header or a sentence. */
export const oneLine = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').trim();

/**
 * One plain, large-text layout for every email. Short sentences and one clear
 * button-style link (target audience: clinic staff, many on older devices).
 * `html` escapes every interpolated value.
 */
export function layout(
  heading: string,
  body: SafeHtml,
  footer = 'If you did not expect this email, you can ignore it.',
): SafeHtml {
  return html`<div
    style="font-family: Arial, Helvetica, sans-serif; font-size: 18px; line-height: 1.5; color: #1a1a1a; max-width: 560px;"
  >
    <h1 style="font-size: 22px;">${heading}</h1>
    ${body}
    <p style="font-size: 15px; color: #555555;">${footer}</p>
    <p style="font-size: 15px; color: #555555;">DocTayo</p>
  </div>`;
}

export const linkButton = (href: string, label: string): SafeHtml =>
  html`<p>
    <a
      href="${href}"
      style="display: inline-block; padding: 12px 20px; background: #0b5ed7; color: #ffffff; text-decoration: none; border-radius: 6px;"
      >${label}</a
    >
  </p>`;
