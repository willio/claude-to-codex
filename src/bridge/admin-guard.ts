import type { Request, Response, NextFunction } from "express";

/**
 * Loopback + shared-secret guard for admin endpoints. Defense in depth:
 * rejects anything that arrived through a proxy/tunnel and does not
 * advertise the admin surface to unauthenticated probes (404).
 */
export function createAdminGuard(adminToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };
}
