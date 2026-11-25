import jsQR from '../vendor/jsqr.js';

export async function readPaymentQr(file, upi) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('Choose a PNG, JPG or WebP image up to 8 MB.');
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('Could not open that image. Choose a clear UPI QR image.');
  });
  const canvas = document.createElement('canvas');
  const ratio = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  try {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(pixels.data, canvas.width, canvas.height);
  const payment = parsePayment(decoded?.data);
  if (!payment) throw new Error('Upload a clear payment QR from your UPI app.');
  if (payment !== upi) throw new Error('The QR points to a different UPI ID. Upload the QR for the ID you entered.');

  const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = decoded.location;
  const corners = [topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner];
  const left = Math.max(0, Math.floor(Math.min(...corners.map(({ x }) => x))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(({ y }) => y))));
  const width = Math.min(canvas.width, Math.ceil(Math.max(...corners.map(({ x }) => x)))) - left;
  const height = Math.min(canvas.height, Math.ceil(Math.max(...corners.map(({ y }) => y)))) - top;
  const border = Math.ceil(Math.max(width, height) / 5);
  const cropped = document.createElement('canvas');
  cropped.width = width + border * 2;
  cropped.height = height + border * 2;
  const output = cropped.getContext('2d');
  output.fillStyle = '#fff';
  output.fillRect(0, 0, cropped.width, cropped.height);
  output.drawImage(canvas, left, top, width, height, border, border, width, height);
  const base64 = cropped.toDataURL('image/png').split(',')[1];
  if (base64.length > 350000) throw new Error('Crop the image around the QR code and try again.');
  return base64;
}

function parsePayment(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'upi:' || url.hostname !== 'pay' || url.searchParams.getAll('pa').length !== 1) return null;
    return url.searchParams.get('pa').trim().toLowerCase();
  } catch {
    return null;
  }
}

export function paymentQrSource(base64) {
  return typeof base64 === 'string' && base64.length <= 350000 && /^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(base64)
    ? 'data:image/png;base64,' + base64
    : null;
}
