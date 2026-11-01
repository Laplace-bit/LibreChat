import type { ImageContent } from '@earendil-works/pi-ai';

export interface PiSteerContent {
  text: string;
  images: ImageContent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageFromDataUrl(value: string): ImageContent | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (match == null) {
    return undefined;
  }
  const [, mimeType, rawData] = match;
  const data = rawData.replace(/[\r\n]/g, '');
  if (
    data.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    return undefined;
  }
  return { type: 'image', mimeType, data };
}

function imageFromBlock(value: Record<string, unknown>): ImageContent | undefined {
  if (value.type === 'image_url') {
    const imageUrl = value.image_url;
    let url: unknown;
    if (typeof imageUrl === 'string') {
      url = imageUrl;
    } else if (isRecord(imageUrl)) {
      url = imageUrl.url;
    }
    return typeof url === 'string' ? imageFromDataUrl(url) : undefined;
  }

  const source = isRecord(value.source) ? value.source : value;
  const data = source.data;
  const mimeType = source.mimeType ?? source.mime_type ?? source.media_type;
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return undefined;
  }
  const dataUrl = data.startsWith('data:') ? data : `data:${mimeType};base64,${data}`;
  return imageFromDataUrl(dataUrl);
}

/**
 * Converts only host-authorized, inline Pi-compatible steer media. Text and
 * images are supported by AgentSession.steer; remote images and other media
 * fail explicitly instead of being silently omitted from the next request.
 */
export function convertPiSteerContent(content: unknown): PiSteerContent {
  if (typeof content === 'string') {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    throw new Error('Pi cannot represent the queued steer content.');
  }

  const textParts: string[] = [];
  const images: ImageContent[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      throw new Error('Pi cannot represent an untyped queued steer content block.');
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new Error('Pi cannot represent a queued steer text block without text.');
      }
      if (part.text.length > 0) {
        textParts.push(part.text);
      }
      continue;
    }
    if (part.type === 'image' || part.type === 'image_url') {
      const image = imageFromBlock(part);
      if (image == null) {
        throw new Error('Pi queued steers only support host-authorized inline base64 images.');
      }
      images.push(image);
      continue;
    }
    throw new Error(`Pi cannot represent the '${part.type}' queued steer media block.`);
  }

  return { text: textParts.join('\n'), images };
}
