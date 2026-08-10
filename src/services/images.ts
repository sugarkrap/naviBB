import sharp from 'sharp';

export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 256;

export const resizeImage = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer)
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

export const resizeLogo = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer, { animated: true })
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .gif()
    .toBuffer();
