import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

const components = {
  // Links never navigate the window; main opens https links in the browser
  // (and refuses anything else).
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          void window.dustm.openExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
  // Agent text is untrusted, and an <img> fetches the moment it renders. The
  // packaged page is a file:// URL, so the CSP's img-src 'self' would admit
  // file: URLs - on Windows a UNC one (file://host/share/x.png) opens an SMB
  // connection that leaks the user's NTLM hash. So no <img> is ever
  // rendered: an image is shown as a link the user can choose to open
  // (https only, in the browser). react-markdown's own URL filter already
  // empties data:/javascript: URLs, so there is nothing safe left to inline.
  img: ({ src, alt }: { src?: unknown; alt?: string }) => {
    const url = typeof src === "string" ? src : "";
    return (
      <a
        href={url}
        className="md-image-link"
        onClick={(e) => {
          e.preventDefault();
          if (url) {
            void window.dustm.openExternal(url);
          }
        }}
      >
        [image{alt ? `: ${alt}` : ""}]
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
