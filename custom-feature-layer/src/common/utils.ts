export function i8888to32(a: number, b: number, c: number, d: number): number {
  return (a & 0x0ff) | ((b & 0x0ff) << 8) | ((c & 0x0ff) << 16) | (d << 24);
}

export function testVectorInsideCar(W: number, H: number, rotation: number, dx: number, dy: number): boolean {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);

  const alpha = 2 * (c * dx + dy * s) / W;
  const beta = 2 * (-s * dx + dy * c) / H;

  return alpha >= -1 && alpha <= +1 && beta >= -1 && beta <= +1;
}