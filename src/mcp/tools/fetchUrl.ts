import { z } from "zod";

import { FETCH_MAX_CHARS, fetchUrl } from "../../utils/urlFetch.js";
import type { McpTool } from "../types/tools.js";

/**
 * Complements the agent's own server-side web search: search finds pages,
 * this opens one you already have the URL for (a search result, a link the
 * user pasted, a GitHub raw file). See utils/urlFetch.ts for how content is
 * processed and what's refused.
 */
export class FetchUrlTool implements McpTool {
  name = "fetch_url";

  description =
    "Fetches the content of a specific URL over HTTP(S) - a GitHub file, an API endpoint, a documentation page, " +
    "or any other URL you already have. This is not the same as web search: search finds pages for a query, this " +
    "opens one whose URL you already know. GET only; http:// and https:// only.\n\n" +
    "HTML pages are reduced to visible text - formatting, links and images are not preserved, and a page whose " +
    "real content only appears after client-side JavaScript runs will come back sparse or empty (there is no " +
    "browser behind this, just a fetch). Prefer a plain-text or API alternative when one exists: for a file in a " +
    "GitHub repo, use raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> rather than the github.com page; " +
    "for repository metadata, issues, or search, use the api.github.com REST API (returned as pretty-printed JSON) " +
    "rather than scraping the website.\n\n" +
    `Responses are capped at ${FETCH_MAX_CHARS.toLocaleString()} characters; anything longer is truncated with a note. ` +
    "Binary content (images, PDFs, archives, and similar) is refused rather than returned as unreadable bytes, and " +
    "requests to private or internal network addresses are refused outright.";

  inputSchema = z.object({
    url: z
      .string()
      .describe(
        "The absolute URL to fetch, including the scheme (e.g. 'https://raw.githubusercontent.com/owner/repo/main/README.md')."
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds. Defaults to 15000."),
  });

  async execute({ url, timeout }: z.infer<typeof this.inputSchema>) {
    const result = await fetchUrl(url, timeout);

    if (result.isErr()) {
      return {
        content: [{ type: "text" as const, text: result.error.message }],
        isError: true,
      };
    }

    const { finalUrl, status, contentType, content, truncatedFrom } =
      result.value;
    const header = [
      `URL: ${finalUrl}`,
      `Status: ${status}`,
      `Content-Type: ${contentType}`,
      truncatedFrom
        ? `[truncated - showing ${FETCH_MAX_CHARS.toLocaleString()} of ${truncatedFrom.toLocaleString()} characters]`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: `${header}\n\n${content}` }],
    };
  }
}
