/**
 * A photo a phone takes is 3–8 MB; the API accepts at most 300 KB of JPEG/PNG/WebP so the
 * menu and the courier profile stay small enough to render instantly on a slow mobile link.
 * Everything is resized and re-encoded in the browser before it is sent.
 */
export const PHOTO_MAX_BYTES = 300 * 1024;
export const PHOTO_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

function loadBitmap(file: File): Promise<{ width: number; height: number; draw: (context: CanvasRenderingContext2D, width: number, height: number) => void; close: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
        close: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('این فایل به‌عنوان تصویر خوانده نشد.')); };
    image.src = url;
  });
}

/** Downscales, re-encodes and returns a data URL that the API will accept. */
export async function photoToDataUrl(file: File, maxBytes = PHOTO_MAX_BYTES): Promise<string> {
  if (!ACCEPTED.includes(file.type)) throw new Error('فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.');
  if (file.size > PHOTO_MAX_SOURCE_BYTES) throw new Error('حجم فایل بیش از ۱۲ مگابایت است؛ یک عکس کوچک‌تر انتخاب کنید.');
  const bitmap = await loadBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('این تصویر ابعاد معتبری ندارد.');
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, 1200 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('مرورگر شما از تغییر اندازهٔ تصویر پشتیبانی نمی‌کند.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    bitmap.draw(context, canvas.width, canvas.height);
    for (const quality of [0.82, 0.7, 0.58, 0.45, 0.34]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= maxBytes) return dataUrl;
    }
    throw new Error('تصویر پس از فشرده‌سازی هم بزرگ است؛ کادر نزدیک‌تری انتخاب کنید.');
  } finally {
    bitmap.close();
  }
}
