import sharp from 'sharp';

export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 256;

const BACKGROUND_COLOR_DISTANCE = 32;

const colourDistance = (
  a: [number, number, number],
  b: [number, number, number],
): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

const removeBackgroundColor = async (
  buffer: Buffer,
  backgroundColor?: [number, number, number],
): Promise<Buffer> => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bg = backgroundColor ?? [data[0], data[1], data[2]];

  for (let i = 0; i < data.length; i += 4) {
    const pixel: [number, number, number] = [
      data[i],
      data[i + 1],
      data[i + 2],
    ];
    if (colourDistance(pixel, bg) <= BACKGROUND_COLOR_DISTANCE) {
      data[i + 3] = 0;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .gif()
    .toBuffer();
};

export const resizeImage = (buffer: Buffer): Promise<Buffer> =>
  sharp(buffer)
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

export const resizeLogo = async (buffer: Buffer): Promise<Buffer> => {
  const meta = await sharp(buffer).metadata();
  if (meta.hasAlpha && meta.channels && meta.channels > 3) {
    return sharp(buffer)
      .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .gif()
      .toBuffer();
  }

  return removeBackgroundColor(buffer);
};
