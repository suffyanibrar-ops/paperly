import { Component, Suspense, lazy, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Header, Footer, BackToTop } from "@/components/Chrome";
import { useRoute } from "@/lib/router";
import { Alert, Spinner } from "@/components/ui";
import { getTool, type ToolCategory } from "@/lib/toolRegistry";

/**
 * Route-level code splitting: the marketing shell (header, footer, styles,
 * router) paints first, then the requested page loads on demand. Tool engines
 * are one level deeper still (src/pages/ToolPage.tsx).
 */
const Home = lazy(() => import("@/pages/Home").then((module) => ({ default: module.default })));
const Tools = lazy(() => import("@/pages/Tools").then((module) => ({ default: module.default })));
const ToolPage = lazy(() => import("@/pages/ToolPage").then((module) => ({ default: module.default })));
const VersusPage = lazy(() => import("@/pages/Versus").then((module) => ({ default: module.default })));
const WhyPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.WhyPage })));
const PricingPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.PricingPage })));
const PrivacyPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.PrivacyPage })));
const TermsPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.TermsPage })));
const HelpPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.HelpPage })));
const NotFoundPage = lazy(() => import("@/pages/Info").then((module) => ({ default: module.NotFoundPage })));
const AboutPage = lazy(() => import("@/pages/More").then((module) => ({ default: module.AboutPage })));
const ActivityPage = lazy(() => import("@/pages/More").then((module) => ({ default: module.ActivityPage })));
const ContactPage = lazy(() => import("@/pages/More").then((module) => ({ default: module.ContactPage })));
const GuidesPage = lazy(() => import("@/pages/More").then((module) => ({ default: module.GuidesPage })));
const SitemapPage = lazy(() => import("@/pages/More").then((module) => ({ default: module.SitemapPage })));

function PageLoading() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
      <Spinner className="h-6 w-6 text-forest" />
      <p className="text-[12px] font-medium text-ink/70">Opening this page…</p>
    </div>
  );
}

class ToolErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Paperly tool error", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="container-page py-16">
          <div className="mx-auto max-w-xl space-y-4 text-center">
            <h1 className="text-[28px] font-semibold tracking-[-0.03em]">That tool hit a snag.</h1>
            <p className="text-[13.5px] leading-relaxed text-muted">
              Your file never left the device. This was a local error — usually a malformed PDF or an unsupported encoding.
            </p>
            <Alert tone="error">{this.state.error.message}</Alert>
            <div className="flex justify-center gap-2">
              <button type="button" onClick={() => this.setState({ error: null })} className="h-11 rounded-xl bg-ink px-5 text-[13px] font-medium text-paper">
                Try again
              </button>
              <a href="#/tools" className="flex h-11 items-center rounded-xl border border-line bg-paper px-5 text-[13px] font-medium">
                Choose another tool
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const route = useRoute();
  const [pathname, search] = route.split("?");
  const params = new URLSearchParams(search ?? "");
  const path = pathname.replace(/\/+$/, "") || "/";

  useEffect(() => {
    const setMeta = (selector: string, attribute: string, value: string) => {
      let node = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
      if (!node) {
        node = document.createElement(selector.startsWith("link") ? "link" : "meta");
        if (selector.startsWith("link")) (node as HTMLLinkElement).rel = "canonical";
        else (node as HTMLMetaElement).name = selector.replace(/^meta\[name="|"\]$/g, "");
        document.head.appendChild(node);
      }
      node.setAttribute(attribute, value);
    };
    const titles: Record<string, string> = {
      "/": "Paperly — Private PDF tools that work in your browser",
      "/tools": "All PDF tools — Paperly",
      "/why": "Why Paperly — Privacy by architecture",
      "/privacy": "Privacy promise — Paperly",
      "/pricing": "Pricing — Paperly",
      "/help": "Help & FAQ — Paperly",
      "/terms": "Terms of use — Paperly",
      "/guides": "Guides & tutorials — Paperly",
      "/activity": "Your activity — Paperly",
      "/about": "About Paperly",
      "/contact": "Contact Paperly",
      "/sitemap": "Sitemap — Paperly",
      "/vs-ilovepdf": "Paperly vs iLovePDF — honest comparison",
    };
    let title: string;
    let description: string;
    if (path.startsWith("/tool/")) {
      const tool = getTool(path.replace("/tool/", ""));
      title = tool ? `${tool.name} — free, private, in-browser | Paperly` : "Tool not found — Paperly";
      description = tool
        ? `${tool.tagline} ${tool.description} All processing happens in your browser — your file is never uploaded.`
        : "This Paperly tool could not be found.";
    } else {
      title = titles[path] ?? "Page not found — Paperly";
      description =
        path === "/"
          ? "50 PDF tools that run entirely in your browser: merge, compress, OCR, redact, ask, inspect, sanitize, convert, sign and fill forms. No uploads, no accounts, no file-size tiers."
          : path === "/tools"
            ? "Browse every Paperly PDF tool across organize, convert, optimize, secure and intelligence categories."
            : path === "/vs-ilovepdf"
              ? "A sourced comparison of Paperly and iLovePDF covering privacy, free limits, batch processing, forms, OCR and PDF/A."
              : "Private, in-browser PDF tools from Paperly. Your documents never leave your device.";
    }
    document.title = title;
    setMeta('meta[name="description"]', "content", description.slice(0, 300));
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const canonicalUrl = `https://paperlypdf.netlify.app${path === "/" ? "/" : path}`;
    if (canonical) canonical.href = canonicalUrl;
    document.head.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]').forEach((node) => node.setAttribute("content", title));
    document.head.querySelectorAll('meta[property="og:description"], meta[name="twitter:description"]').forEach((node) => node.setAttribute("content", description.slice(0, 200)));
    const ogUrl = document.head.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute("content", canonicalUrl);
  }, [path]);

  let page: ReactNode;
  if (path === "/" || path === "") page = <Home />;
  else if (path === "/tools") {
    const category = params.get("c");
    page = <Tools initialCategory={(category as ToolCategory) || "all"} initialNew={params.get("new") === "1"} />;
  } else if (path.startsWith("/tool/")) page = <ToolPage toolId={path.replace("/tool/", "")} />;
  else if (path === "/why") page = <WhyPage />;
  else if (path === "/privacy") page = <PrivacyPage />;
  else if (path === "/pricing") page = <PricingPage />;
  else if (path === "/help") page = <HelpPage />;
  else if (path === "/terms") page = <TermsPage />;
  else if (path === "/guides") page = <GuidesPage initialGuide={params.get("g") ?? undefined} />;
  else if (path === "/activity") page = <ActivityPage />;
  else if (path === "/about") page = <AboutPage />;
  else if (path === "/contact") page = <ContactPage />;
  else if (path === "/sitemap") page = <SitemapPage />;
  else if (path === "/vs-ilovepdf") page = <VersusPage />;
  else page = <NotFoundPage />;

  return (
    <div className="flex min-h-screen flex-col bg-bone">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-paper"
      >
        Skip to content
      </a>
      <Header />
      <main id="main-content" className="flex-1">
        <ToolErrorBoundary>
          <Suspense fallback={<PageLoading />}>{page}</Suspense>
        </ToolErrorBoundary>
      </main>
      <Footer />
      <BackToTop />
    </div>
  );
}
