import { createHash } from "node:crypto";
import type { Response } from "express";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allow one specific inline script via CSP hash. Anything else stays blocked
 * by `default-src 'none'`.
 */
export function setAuthSecurityHeaders(res: Response, opts: { script?: string } = {}): void {
  const scriptSrc = opts.script
    ? `script-src 'sha256-${createHash("sha256").update(opts.script).digest("base64")}';`
    : "";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; ${scriptSrc} form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}
