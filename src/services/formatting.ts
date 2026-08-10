export type PostProcessor = 'bbcode' | 'markdown';

const ALLOWED_URL = /^https?:\/\/[^\s<>"]+$/i;

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

type Token =
  | { type: 'text'; value: string }
  | { type: 'open'; tag: string; value?: string }
  | { type: 'close'; tag: string };

const ALIGN_VALUES = new Set(['left', 'center', 'right']);

const parseBBCode = (input: string): Token[] => {
  const tokens: Token[] = [];
  const regex = /\[(\/?)(b|i|u|url|img|align)(?:=([^\]]+))?\]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: input.slice(lastIndex, match.index) });
    }
    const slash = match[1];
    const tag = match[2].toLowerCase();
    const value = match[3];
    if (slash) {
      tokens.push({ type: 'close', tag });
    } else {
      tokens.push({ type: 'open', tag, value });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) {
    tokens.push({ type: 'text', value: input.slice(lastIndex) });
  }
  return tokens;
};

const makeLink = (href: string, text: string): string => {
  if (!ALLOWED_URL.test(href)) {
    return escapeHtml(text);
  }
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
};

const makeImage = (src: string): string => {
  if (!ALLOWED_URL.test(src)) {
    return escapeHtml(src);
  }
  return `<img src="${escapeHtml(src)}" alt="">`;
};

const renderBBCode = (input: string): string => {
  const tokens = parseBBCode(input);
  const tagStack: string[] = [];
  const hrefStack: (string | null)[] = [];
  const out: string[] = [];

  for (const token of tokens) {
    if (token.type === 'text') {
      const top = tagStack[tagStack.length - 1];
      if (top === 'img') {
        out.push(makeImage(token.value.trim()));
      } else if (top === 'url') {
        const href = hrefStack[hrefStack.length - 1] ?? token.value.trim();
        out.push(makeLink(href, token.value));
      } else {
        out.push(escapeHtml(token.value));
      }
    } else if (token.type === 'open') {
      if (token.tag === 'b') {
        out.push('<strong>');
        tagStack.push('b');
      } else if (token.tag === 'i') {
        out.push('<em>');
        tagStack.push('i');
      } else if (token.tag === 'u') {
        out.push('<u>');
        tagStack.push('u');
      } else if (token.tag === 'url') {
        tagStack.push('url');
        hrefStack.push(token.value ?? null);
      } else if (token.tag === 'img') {
        tagStack.push('img');
        hrefStack.push(null);
      } else if (token.tag === 'align') {
        const requested = token.value?.toLowerCase();
        const align =
          requested && ALIGN_VALUES.has(requested) ? requested : 'left';
        out.push(`<div style="text-align: ${align}">`);
        tagStack.push('align');
      }
    } else if (token.type === 'close') {
      const top = tagStack.pop();
      if (top === 'url' || top === 'img') hrefStack.pop();
      if (top === token.tag) {
        if (token.tag === 'b') out.push('</strong>');
        else if (token.tag === 'i') out.push('</em>');
        else if (token.tag === 'u') out.push('</u>');
        else if (token.tag === 'align') out.push('</div>');
      }
    }
  }

  // close any unclosed tags
  while (tagStack.length > 0) {
    const tag = tagStack.pop();
    if (tag === 'b') out.push('</strong>');
    else if (tag === 'i') out.push('</em>');
    else if (tag === 'u') out.push('</u>');
    else if (tag === 'align') out.push('</div>');
  }

  return out.join('');
};

const renderMarkdown = (input: string): string => {
  const placeholders: string[] = [];
  const placeholder = (id: number): string => `\x00NAVIBB_HTML_${id}\x00`;
  const stash = (html: string): string => {
    const id = placeholders.length;
    placeholders.push(html);
    return placeholder(id);
  };
  const resolvePlaceholders = (text: string): string =>
    text.replace(
      /\x00NAVIBB_HTML_(\d+)\x00/g,
      (_, id) => placeholders[parseInt(id, 10)],
    );

  const ensureProtocol = (url: string): string => {
    if (!/^https?:\/\//.test(url)) {
      return `https://${url}`;
    }
    return url;
  };

  const renderInline = (input: string): string => {
    let text = input;

    text = text.replace(
      /\[align=(left|center|right)\]([\s\S]*?)\[\/align\]/gi,
      (_match, value, inner) =>
        stash(
          `<div style="text-align: ${value.toLowerCase()}">${renderInline(inner)}</div>`,
        ),
    );

    text = text.replace(/!\[([^[\]]*)\]\(([^\s)]+)\)/g, (_match, alt, url) =>
      stash(
        `<img src="${escapeHtml(ensureProtocol(url))}" alt="${escapeHtml(alt)}" loading="lazy">`,
      ),
    );

    text = text.replace(/\[([^[\]]+)\]\(([^\s)]+)\)/g, (_match, label, url) =>
      stash(
        `<a href="${escapeHtml(ensureProtocol(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
      ),
    );

    text = escapeHtml(text);

    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*]+)\*(?![*])/g, '$1<em>$2</em>');
    text = text.replace(/__([^_]+)__/g, '<u>$1</u>');
    text = text.replace(/\n/g, '<br>');

    return resolvePlaceholders(text);
  };

  return renderInline(input);
};

export const renderPost = (
  content: string,
  processor: PostProcessor,
): string => {
  if (processor === 'markdown') return renderMarkdown(content);
  return renderBBCode(content);
};

export const renderSignature = (
  signature: string,
  processor: PostProcessor,
): string => renderPost(signature, processor);
