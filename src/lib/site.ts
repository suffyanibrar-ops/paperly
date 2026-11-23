/**
 * One place for the public origin.
 *
 * Set `VITE_SITE_URL` (or `SITE_URL` for the prerender/build scripts) in the
 * hosting environment. The fallback is the production brand domain — no
 * hardcoded Netlify preview URL belongs in a canonical tag.
 */
const env = typeof import.meta !== "undefined" ? (import.meta.env as Record<string, string | undefined>) : {};
const configured = env.VITE_SITE_URL || env.SITE_URL;

export const SITE_URL = (configured && String(configured).trim()) || "https://paperlypdf.com";

/** Absolute URL for a route, with exactly one slash at the join. */
export function absoluteUrl(path = "/"): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL.replace(/\/+$/, "")}${clean === "/" ? "/" : clean}`;
}

/** The canonical route for a pathname, normalising a legacy `/tool/:id` URL. */
export function canonicalPath(path: string): string {
  const clean = (path.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  return clean;
}
