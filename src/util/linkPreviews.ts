import logger from "../logger";

interface LinkMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  type?: string;
  url: string;
  domain: string;
}

function extractUrls(text: string): string[] {
  const urlRegex =
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/g;
  return text.match(urlRegex) || [];
}

async function getYouTubeInfo(url: string): Promise<LinkMetadata> {
  try {
    const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
    if (!videoId) throw new Error("Invalid YouTube URL");

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };

    return {
      title: data.title || "Unknown Title",
      description: `by ${data.author_name || "Unknown Channel"}`,
      siteName: "YouTube",
      image: data.thumbnail_url,
      type: "video",
      url,
      domain: "youtube.com",
    };
  } catch (error) {
    logger.error("Failed to get YouTube info:", error);
    const domain = new URL(url).hostname;
    return {
      title: "YouTube video",
      url,
      domain,
    };
  }
}

async function fetchPageMetadata(url: string): Promise<LinkMetadata> {
  const domain = new URL(url).hostname;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkPreview/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw new Error("Not an HTML page");
    }

    const html = await response.text();
    return parseHtmlMetadata(html, url, domain);
  } catch (error) {
    logger.error(`Failed to fetch metadata for ${url}:`, error);
    return {
      title: domain,
      url,
      domain,
    };
  }
}

function parseHtmlMetadata(html: string, url: string, domain: string): LinkMetadata {
  const metadata: LinkMetadata = { url, domain };

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // Extract meta tags
  const metaRegex = /<meta[^>]+>/gi;
  const metaTags = html.match(metaRegex) || [];

  for (const tag of metaTags) {
    const propertyMatch = tag.match(/(?:property|name)=["']([^"']+)["'][^>]*content=["']([^"']*)["']/i);
    if (!propertyMatch) continue;

    const [, property, content] = propertyMatch;
    const cleanContent = decodeHtmlEntities(content.trim());

    if (!cleanContent) continue;

    switch (property.toLowerCase()) {
      case "og:title":
      case "twitter:title":
        if (!metadata.title || cleanContent.length > metadata.title.length) {
          metadata.title = cleanContent;
        }
        break;
      case "og:description":
      case "twitter:description":
      case "description":
        if (!metadata.description || cleanContent.length > metadata.description.length) {
          metadata.description = cleanContent;
        }
        break;
      case "og:site_name":
      case "twitter:site":
        metadata.siteName = cleanContent.replace("@", "");
        break;
      case "og:image":
      case "twitter:image":
        metadata.image = cleanContent;
        break;
      case "og:type":
        metadata.type = cleanContent;
        break;
    }
  }

  // Fallback to domain if no title found
  if (!metadata.title) {
    metadata.title = domain;
  }

  // Truncate long descriptions
  if (metadata.description && metadata.description.length > 200) {
    metadata.description = metadata.description.substring(0, 197) + "...";
  }

  return metadata;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  return text.replace(/&(?:#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match) => {
    if (entities[match.toLowerCase()]) {
      return entities[match.toLowerCase()];
    }
    // Handle numeric entities
    if (match.startsWith("&#")) {
      const num = match.startsWith("&#x") ? parseInt(match.slice(3, -1), 16) : parseInt(match.slice(2, -1), 10);
      return String.fromCharCode(num);
    }
    return match;
  });
}

async function getGenericLinkInfo(url: string): Promise<LinkMetadata> {
  // Handle special cases
  const domain = new URL(url).hostname.toLowerCase();

  if (domain.includes("github.com")) {
    return await fetchGitHubInfo(url);
  }

  if (domain.includes("twitter.com") || domain.includes("x.com")) {
    return await fetchTwitterInfo(url);
  }

  // For other sites, fetch general metadata
  return await fetchPageMetadata(url);
}

async function fetchGitHubInfo(url: string): Promise<LinkMetadata> {
  try {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error("Invalid GitHub URL");

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as {
      name: string;
      description: string;
      full_name: string;
      stargazers_count: number;
      language: string;
    };

    return {
      title: data.full_name,
      description: `${data.description || "No description"} • ⭐ ${data.stargazers_count} • ${data.language || "Multiple languages"}`,
      siteName: "GitHub",
      type: "repository",
      url,
      domain: "github.com",
    };
  } catch (error) {
    logger.error("Failed to get GitHub info:", error);
    return await fetchPageMetadata(url);
  }
}

async function fetchTwitterInfo(url: string): Promise<LinkMetadata> {
  // Twitter's API requires authentication, so fall back to page scraping
  // You might want to implement Twitter API integration here
  return await fetchPageMetadata(url);
}

function formatLinkMetadata(metadata: LinkMetadata): string {
  const parts = [];

  if (metadata.siteName) {
    parts.push(metadata.siteName);
  } else {
    parts.push(metadata.domain);
  }

  if (metadata.title && metadata.title !== metadata.domain) {
    parts.push(`"${metadata.title}"`);
  }

  if (metadata.description) {
    parts.push(metadata.description);
  }

  return parts.join(": ");
}

// Enhanced cache with TTL
class LinkMetadataCache {
  private cache = new Map<string, { data: LinkMetadata; timestamp: number }>();
  private readonly TTL = 24 * 60 * 60 * 1000; // 24 hours

  get(url: string): LinkMetadata | undefined {
    const entry = this.cache.get(url);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.TTL) {
      this.cache.delete(url);
      return undefined;
    }

    return entry.data;
  }

  set(url: string, data: LinkMetadata): void {
    this.cache.set(url, { data, timestamp: Date.now() });
  }

  has(url: string): boolean {
    return this.get(url) !== undefined;
  }
}

const linkMetadataCache = new LinkMetadataCache();

export async function processLinks(text: string): Promise<string> {
  const urls = extractUrls(text);
  if (urls.length === 0) return "";

  const linkDescriptions = [];

  for (const url of urls) {
    // Check cache first
    if (linkMetadataCache.has(url)) {
      const cached = linkMetadataCache.get(url)!;
      linkDescriptions.push(formatLinkMetadata(cached));
      continue;
    }

    let metadata: LinkMetadata;

    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      metadata = await getYouTubeInfo(url);
    } else {
      metadata = await getGenericLinkInfo(url);
    }

    // Cache the result
    linkMetadataCache.set(url, metadata);
    linkDescriptions.push(formatLinkMetadata(metadata));
  }

  return linkDescriptions.length > 0 ? ` [Links: ${linkDescriptions.join(" | ")}]` : "";
}
